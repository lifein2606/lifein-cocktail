const express = require('express');
const path = require('path');
const https = require('https');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// 聊天图片上传目录
const UPLOADS_DIR = path.join(__dirname, 'chat-uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
app.use('/chat-uploads', express.static(UPLOADS_DIR));

// ====== 配置区域 ======
const ARK_API_KEY = process.env.ARK_API_KEY || '';
const ARK_MODEL = process.env.ARK_MODEL || 'doubao-seedream-5-0-260128';
const COZE_API_TOKEN = process.env.COZE_API_TOKEN || '';
const COZE_BOT_ID = process.env.COZE_BOT_ID || '';
// =======================

app.use(express.json({ limit: '20mb' }));
app.use(express.static(__dirname));

// 显式根路由，确保首页可访问
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// 健康检查
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        ark_configured: !!ARK_API_KEY,
        model: ARK_MODEL,
        coze_configured: !!(COZE_API_TOKEN && COZE_BOT_ID)
    });
});

// ====== 聊天图片上传 ======
app.post('/api/upload-chat-image', (req, res) => {
    const { image } = req.body;
    if (!image) {
        return res.status(400).json({ error: '请提供图片' });
    }

    const matches = image.match(/^data:image\/(.*);base64,(.*)$/);
    if (!matches) {
        return res.status(400).json({ error: '图片格式无效' });
    }

    const ext = matches[1] === 'jpeg' ? 'jpg' : (matches[1] || 'png');
    const base64Data = matches[2];
    const filename = `chat_${Date.now()}_${Math.random().toString(36).substr(2, 8)}.${ext}`;
    const filepath = path.join(UPLOADS_DIR, filename);

    fs.writeFile(filepath, base64Data, 'base64', (err) => {
        if (err) {
            console.error('❌ 保存聊天图片失败:', err.message);
            return res.status(500).json({ error: '保存图片失败' });
        }
        const imageUrl = `${req.protocol}://${req.get('host')}/chat-uploads/${filename}`;
        console.log(`📷 聊天图片已保存: ${filename}`);
        res.json({ url: imageUrl });
    });
});

// ====== AI 聊天（Coze Bot API） ======
app.post('/api/chat', async (req, res) => {
    const { message, conversation_id, user_id, image_url } = req.body;

    if (!COZE_API_TOKEN || !COZE_BOT_ID) {
        return res.status(503).json({
            error: 'AI聊天服务未配置',
            hint: '请设置 COZE_API_TOKEN 和 COZE_BOT_ID 环境变量',
            fallback: true
        });
    }

    if (!message) {
        return res.status(400).json({ error: '消息不能为空' });
    }

    req.setTimeout(60000);

    try {
        console.log(`💬 Coze Chat: "${message.slice(0, 30)}..."${image_url ? ' [含图片]' : ''}`);
        const result = await callCozeChat(message, conversation_id, user_id, image_url);
        console.log(`✅ AI回复成功`);
        res.json(result);
    } catch (err) {
        console.error('❌ Coze Chat失败:', err.message);
        res.status(500).json({ error: `AI回复失败: ${err.message}`, fallback: true });
    }
});

// Coze Bot API 调用（非流式 + 轮询）
function callCozeChat(message, conversationId, userId, imageUrl) {
    return new Promise((resolve, reject) => {
        // 构建消息列表（支持图片+文字）
        const additionalMessages = [];
        if (imageUrl) {
            additionalMessages.push({ role: 'user', content: imageUrl, content_type: 'image' });
        }
        additionalMessages.push({ role: 'user', content: message, content_type: 'text' });

        const reqBody = JSON.stringify({
            bot_id: COZE_BOT_ID,
            user_id: userId || 'web_user',
            stream: false,
            auto_save_history: true,
            ...(conversationId ? { conversation_id: conversationId } : {}),
            additional_messages: additionalMessages
        });

        const options = {
            hostname: 'api.coze.cn',
            port: 443,
            path: '/v3/chat',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${COZE_API_TOKEN}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(reqBody)
            }
        };

        const request = https.request(options, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    if (parsed.code !== 0) {
                        reject(new Error(parsed.msg || JSON.stringify(parsed)));
                        return;
                    }

                    const chatId = parsed.data.id;
                    const convId = parsed.data.conversation_id;

                    // 轮询等待完成
                    pollCozeChat(chatId, convId, resolve, reject);
                } catch (e) {
                    reject(new Error('解析响应失败: ' + e.message));
                }
            });
        });

        request.on('error', (e) => reject(new Error('网络请求失败: ' + e.message)));
        request.setTimeout(30000, () => {
            request.destroy();
            reject(new Error('创建对话超时'));
        });
        request.write(reqBody);
        request.end();
    });
}

// 轮询对话状态
function pollCozeChat(chatId, conversationId, resolve, reject, attempts = 0) {
    if (attempts > 40) {
        reject(new Error('AI回复超时（60秒）'));
        return;
    }

    const options = {
        hostname: 'api.coze.cn',
        port: 443,
        path: `/v3/chat/retrieve?chat_id=${chatId}&conversation_id=${conversationId}`,
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${COZE_API_TOKEN}`
        }
    };

    const request = https.request(options, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
            try {
                const parsed = JSON.parse(data);
                if (parsed.code !== 0) {
                    reject(new Error(parsed.msg));
                    return;
                }

                const status = parsed.data.status;
                if (status === 'completed') {
                    fetchCozeMessages(chatId, conversationId, resolve, reject);
                } else if (status === 'failed') {
                    reject(new Error('AI处理失败'));
                } else {
                    // created / in_progress，继续轮询
                    setTimeout(() => pollCozeChat(chatId, conversationId, resolve, reject, attempts + 1), 1500);
                }
            } catch (e) {
                reject(e);
            }
        });
    });

    request.on('error', reject);
    request.setTimeout(10000, () => {
        request.destroy();
        reject(new Error('轮询超时'));
    });
    request.end();
}

// 获取对话消息
function fetchCozeMessages(chatId, conversationId, resolve, reject) {
    const options = {
        hostname: 'api.coze.cn',
        port: 443,
        path: `/v3/chat/message/list?chat_id=${chatId}&conversation_id=${conversationId}`,
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${COZE_API_TOKEN}`
        }
    };

    const request = https.request(options, (response) => {
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => {
            try {
                const parsed = JSON.parse(data);
                if (parsed.code !== 0) {
                    reject(new Error(parsed.msg));
                    return;
                }

                // 找到assistant的answer类型消息
                const answerMsg = parsed.data.find(m => m.role === 'assistant' && m.type === 'answer');
                if (answerMsg) {
                    resolve({
                        reply: answerMsg.content,
                        conversation_id: conversationId
                    });
                } else {
                    reject(new Error('未获取到AI回复'));
                }
            } catch (e) {
                reject(e);
            }
        });
    });

    request.on('error', reject);
    request.setTimeout(10000, () => {
        request.destroy();
        reject(new Error('获取消息超时'));
    });
    request.end();
}

// ====== AI 瓶身样机生成 ======
app.post('/api/generate-mockup', async (req, res) => {
    const { image, cocktail_name, cocktail_name_en, volume, alcohol } = req.body;

    if (!image) {
        return res.status(400).json({ error: '请上传照片' });
    }
    if (!cocktail_name) {
        return res.status(400).json({ error: '缺少鸡尾酒名称' });
    }
    if (!ARK_API_KEY) {
        return res.status(503).json({
            error: '图片生成服务未配置',
            hint: '请设置 ARK_API_KEY 环境变量'
        });
    }

    req.setTimeout(180000);

    try {
        const prompt = buildMockupPrompt(cocktail_name, cocktail_name_en, volume, alcohol);
        console.log(`🎨 生成瓶身样机: ${cocktail_name}, 模型: ${ARK_MODEL}`);
        console.log(`📐 图片数据长度: ${image.length} 字符`);
        const imageUrl = await callArkImageAPI(prompt, image);
        console.log(`✅ 生成成功`);
        res.json({ image_url: imageUrl });
    } catch (err) {
        console.error('❌ 图片生成失败:', err.message);
        res.status(500).json({ error: `图片生成失败: ${err.message}` });
    }
});

// 图生图 Prompt：明确告诉模型基于参考图生成
function buildMockupPrompt(name, nameEn, volume, alcohol) {
    const vol = volume || '275ml';
    const alc = alcohol || '16% vol';

    return `基于参考图片生成一张Life In.品牌鸡尾酒瓶身定制效果图。将参考图片的内容完整保留，作为瓶身中央长方形标签的全幅背景。在标签顶部边缘添加一条窄的半透明深色底条，上面用白色优雅字体写品牌名"Life In."。在标签底部边缘添加一条窄的半透明深色底条，上面用白色字体写产品名"${name}"，下方小字写"${vol} | ${alc}"。文字只叠加在标签上下边缘，不遮挡参考图片中间的主体内容。瓶子为透明玻璃瓶配原木色软木塞，标准圆肩直身，放在大理石质感台面上，台面上有少量与鸡尾酒风味相关的水果和植物装饰，背景是柔和的浅色渐变。产品摄影级画质，自然光影，精致质感。`;
}

// 火山引擎 ARK API 调用
function callArkImageAPI(prompt, imageBase64) {
    let imageData = imageBase64;
    if (!imageData.startsWith('data:')) {
        imageData = `data:image/jpeg;base64,${imageData}`;
    }

    const body = JSON.stringify({
        model: ARK_MODEL,
        prompt: prompt,
        image: imageData,
        size: '2K',
        response_format: 'url',
        sequential_image_generation: 'disabled',
        stream: false,
        watermark: false,
        optimize_prompt_options: { mode: 'standard' }
    });

    return new Promise((resolve, reject) => {
        const options = {
            hostname: 'ark.cn-beijing.volces.com',
            port: 443,
            path: '/api/v3/images/generations',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${ARK_API_KEY}`,
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body)
            }
        };

        const request = https.request(options, (response) => {
            let data = '';
            response.on('data', chunk => data += chunk);
            response.on('end', () => {
                try {
                    const parsed = JSON.parse(data);

                    if (parsed.error) {
                        reject(new Error(parsed.error.message || JSON.stringify(parsed.error)));
                        return;
                    }

                    if (parsed.data && parsed.data[0]) {
                        if (parsed.data[0].url) {
                            resolve(parsed.data[0].url);
                        } else if (parsed.data[0].b64_json) {
                            resolve(`data:image/png;base64,${parsed.data[0].b64_json}`);
                        } else {
                            reject(new Error('未获取到图片数据'));
                        }
                    } else {
                        reject(new Error('API 返回格式异常: ' + data.substring(0, 300)));
                    }
                } catch (e) {
                    reject(new Error('解析响应失败: ' + e.message));
                }
            });
        });

        request.on('error', (e) => reject(new Error('网络请求失败: ' + e.message)));
        request.setTimeout(180000, () => {
            request.destroy();
            reject(new Error('请求超时（3分钟）'));
        });
        request.write(body);
        request.end();
    });
}

// ====== 订单管理（服务端存储） ======
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'lifein2026';
const serverOrders = []; // 内存存储，重启后清空

// 用户下单 → 同步到服务端
app.post('/api/orders', (req, res) => {
    const order = req.body;
    if (!order || !order.orderNo) {
        return res.status(400).json({ error: '订单数据无效' });
    }
    serverOrders.unshift(order);
    console.log(`📦 新订单: ${order.orderNo} | ¥${order.total} | ${order.items?.length || 0}件 | 联系方式: ${order.contact || '未留'}`);
    res.json({ ok: true });
});

// 管理端：获取所有订单（需密码）
app.get('/api/orders', (req, res) => {
    const pwd = req.query.password || req.headers['x-admin-password'] || '';
    if (pwd !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: '密码错误' });
    }
    res.json(serverOrders);
});

// 管理端：更新订单状态（需密码）
app.put('/api/orders/:orderNo/status', (req, res) => {
    const pwd = req.body.password || req.headers['x-admin-password'] || '';
    if (pwd !== ADMIN_PASSWORD) {
        return res.status(401).json({ error: '密码错误' });
    }
    const { orderNo } = req.params;
    const { status } = req.body;
    if (!['confirmed', 'cancelled', 'pending', 'completed'].includes(status)) {
        return res.status(400).json({ error: '无效状态' });
    }
    const order = serverOrders.find(o => o.orderNo === orderNo);
    if (!order) {
        return res.status(404).json({ error: '订单不存在' });
    }
    order.status = status;
    console.log(`📦 订单 ${orderNo} → ${status}`);
    res.json({ ok: true, orderNo, status });
});

// 用户端：查询自己订单的状态
app.get('/api/orders/status', (req, res) => {
    const orderNos = req.query.orderNos || '';
    if (!orderNos) return res.json({});
    const nos = orderNos.split(',');
    const result = {};
    for (const no of nos) {
        const order = serverOrders.find(o => o.orderNo === no);
        result[no] = order ? order.status : 'pending';
    }
    res.json(result);
});

// ====== 管理后台页面 ======
app.get('/admin', (req, res) => {
    res.send(getAdminPageHTML());
});

function getAdminPageHTML() {
    return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Life In. 订单管理</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,sans-serif;background:#0f0f0f;color:#e8e0d4;min-height:100vh}
.header{background:linear-gradient(135deg,#1a1a1a,#252525);padding:16px 20px;border-bottom:1px solid rgba(240,160,80,0.2);display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10}
.header h1{font-size:18px;color:#f0a050}
.header-right{display:flex;gap:8px;align-items:center}
.stats{font-size:12px;color:#888;margin-right:8px}
.login-wrap{display:flex;align-items:center;justify-content:center;min-height:80vh}
.login-box{background:#1a1a1a;border:1px solid rgba(240,160,80,0.2);border-radius:16px;padding:32px;width:300px;text-align:center}
.login-box h2{color:#f0a050;margin-bottom:20px;font-size:18px}
.login-box input{width:100%;padding:12px;border:1px solid rgba(240,160,80,0.3);border-radius:10px;background:#0f0f0f;color:#e8e0d4;font-size:15px;outline:none;margin-bottom:16px}
.login-box input:focus{border-color:#f0a050}
.login-box button{width:100%;padding:12px;background:linear-gradient(135deg,#f0a050,#e88a30);color:#fff;border:none;border-radius:10px;font-size:15px;cursor:pointer;font-weight:600}
.orders-list{padding:12px 16px}
.order-card{background:#1a1a1a;border:1px solid rgba(240,160,80,0.15);border-radius:12px;padding:14px;margin-bottom:10px}
.order-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,0.06)}
.order-no{font-size:13px;font-weight:600;color:#f0a050}
.order-time{font-size:11px;color:#666;margin-top:2px}
.order-contact{font-size:12px;color:#aaa;margin-top:4px;display:flex;align-items:center;gap:4px}
.status-badge{padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;white-space:nowrap}
.status-pending{background:rgba(255,200,50,0.15);color:#ffc832}
.status-confirmed{background:rgba(80,200,120,0.15);color:#50c878}
.status-cancelled{background:rgba(255,80,80,0.15);color:#ff5050}
.status-completed{background:rgba(100,160,255,0.15);color:#64a0ff}
.order-item{display:flex;align-items:center;gap:8px;padding:4px 0;font-size:13px}
.order-item-name{font-weight:500}
.order-item-detail{font-size:11px;color:#888}
.order-footer{display:flex;justify-content:space-between;align-items:center;margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.06)}
.order-total{font-size:15px;font-weight:700;color:#f0a050}
.action-btns{display:flex;gap:5px;flex-wrap:wrap}
.action-btn{padding:5px 12px;border-radius:6px;border:none;font-size:11px;font-weight:600;cursor:pointer}
.btn-confirm{background:rgba(80,200,120,0.2);color:#50c878}
.btn-confirm:hover{background:rgba(80,200,120,0.35)}
.btn-complete{background:rgba(100,160,255,0.2);color:#64a0ff}
.btn-complete:hover{background:rgba(100,160,255,0.35)}
.btn-cancel{background:rgba(255,80,80,0.2);color:#ff5050}
.btn-cancel:hover{background:rgba(255,80,80,0.35)}
.btn-reset{background:rgba(255,200,50,0.2);color:#ffc832}
.btn-reset:hover{background:rgba(255,200,50,0.35)}
.empty{text-align:center;padding:60px 20px;color:#555;font-size:14px}
.small-btn{padding:5px 12px;border-radius:6px;cursor:pointer;font-size:12px;border:1px solid rgba(240,160,80,0.3);background:rgba(240,160,80,0.1);color:#f0a050}
.small-btn:hover{background:rgba(240,160,80,0.2)}
.logout-btn{padding:4px 10px;background:rgba(255,255,255,0.05);color:#666;border:1px solid rgba(255,255,255,0.1);border-radius:6px;cursor:pointer;font-size:11px}
.filter-bar{display:flex;gap:6px;padding:8px 16px;flex-wrap:wrap}
.filter-btn{padding:5px 12px;border-radius:20px;border:1px solid rgba(255,255,255,0.1);background:transparent;color:#888;font-size:12px;cursor:pointer}
.filter-btn.active{background:rgba(240,160,80,0.15);color:#f0a050;border-color:rgba(240,160,80,0.3)}
</style>
</head>
<body>
<div class="header">
<h1>🍸 Life In. 订单管理</h1>
<div class="header-right">
<span class="stats" id="stats"></span>
<button class="small-btn" id="refreshBtn" style="display:none">🔄 刷新</button>
<button class="logout-btn" id="logoutBtn" style="display:none">退出</button>
</div>
</div>
<div class="filter-bar" id="filterBar" style="display:none">
<button class="filter-btn active" data-filter="all">全部</button>
<button class="filter-btn" data-filter="pending">待确认</button>
<button class="filter-btn" data-filter="confirmed">已确认</button>
<button class="filter-btn" data-filter="completed">已完成</button>
<button class="filter-btn" data-filter="cancelled">已取消</button>
</div>
<div id="content"></div>
<script>
let password = localStorage.getItem('admin_pwd') || '';
let currentFilter = 'all';

async function login() {
    const pwd = document.getElementById('pwdInput').value;
    if (!pwd) return;
    password = pwd;
    localStorage.setItem('admin_pwd', pwd);
    await loadOrders();
}

async function loadOrders() {
    try {
        const res = await fetch('/api/orders?password=' + encodeURIComponent(password));
        if (res.status === 401) {
            password = '';
            localStorage.removeItem('admin_pwd');
            showLogin('密码错误，请重试');
            return;
        }
        const orders = await res.json();
        showOrders(orders);
    } catch (e) {
        document.getElementById('content').innerHTML = '<div class="empty">加载失败，请检查网络</div>';
    }
}

async function updateStatus(orderNo, status) {
    try {
        const res = await fetch('/api/orders/' + orderNo + '/status', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'X-Admin-Password': password },
            body: JSON.stringify({ status, password })
        });
        if (res.ok) { await loadOrders(); }
        else { alert('操作失败'); }
    } catch (e) { alert('网络错误'); }
}

function showLogin(err) {
    document.getElementById('refreshBtn').style.display = 'none';
    document.getElementById('logoutBtn').style.display = 'none';
    document.getElementById('filterBar').style.display = 'none';
    document.getElementById('stats').textContent = '';
    document.getElementById('content').innerHTML = '<div class="login-wrap"><div class="login-box"><h2>🔐 管理员登录</h2>'+(err?'<p style="color:#ff5050;font-size:13px;margin-bottom:12px">'+err+'</p>':'')+'<input type="password" id="pwdInput" placeholder="输入管理密码" onkeydown="if(event.key===\\'Enter\\')login()"><button onclick="login()">登录</button></div></div>';
}

function showOrders(orders) {
    document.getElementById('refreshBtn').style.display = '';
    document.getElementById('logoutBtn').style.display = '';
    document.getElementById('filterBar').style.display = '';

    const counts = { all: orders.length, pending: 0, confirmed: 0, completed: 0, cancelled: 0 };
    orders.forEach(o => { if (counts[o.status] !== undefined) counts[o.status]++; });
    document.getElementById('stats').textContent = '共' + orders.length + '单';

    // Update filter button texts
    document.querySelectorAll('.filter-btn').forEach(btn => {
        const f = btn.dataset.filter;
        btn.textContent = (f==='all'?'全部':f==='pending'?'待确认':f==='confirmed'?'已确认':f==='completed'?'已完成':'已取消') + '(' + (counts[f]||0) + ')';
    });

    let filtered = currentFilter === 'all' ? orders : orders.filter(o => o.status === currentFilter);

    if (filtered.length === 0) {
        document.getElementById('content').innerHTML = '<div class="empty">📋 暂无' + (currentFilter==='all'?'':'该状态') + '订单</div>';
        return;
    }

    let html = '<div class="orders-list">';
    for (const o of filtered) {
        const d = new Date(o.createdAt);
        const t = d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0')+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0');
        const sl = o.status==='pending'?'待确认':o.status==='confirmed'?'已确认':o.status==='completed'?'已完成':'已取消';
        let items = '';
        for (const it of (o.items||[])) {
            const qty = it.quantity||1;
            const cl = it.capacity<=200?'小瓶':it.capacity<=350?'中瓶':'大瓶';
            items += '<div class="order-item"><div><span class="order-item-name">'+it.cocktailName+'</span> <span class="order-item-detail">'+it.capacity+'ml·'+cl+'×'+qty+'</span></div></div>';
        }
        const contactHtml = o.contact ? '<div class="order-contact">📞 '+o.contact+'</div>' : '';
        let actions = '';
        if (o.status==='pending') {
            actions = '<button class="action-btn btn-confirm" onclick="updateStatus(\\''+o.orderNo+'\\',\\'confirmed\\')">✓ 确认</button><button class="action-btn btn-cancel" onclick="updateStatus(\\''+o.orderNo+'\\',\\'cancelled\\')">✕ 取消</button>';
        } else if (o.status==='confirmed') {
            actions = '<button class="action-btn btn-complete" onclick="updateStatus(\\''+o.orderNo+'\\',\\'completed\\')">✓ 完成</button><button class="action-btn btn-cancel" onclick="updateStatus(\\''+o.orderNo+'\\',\\'cancelled\\')">✕ 取消</button>';
        } else {
            actions = '<button class="action-btn btn-reset" onclick="updateStatus(\\''+o.orderNo+'\\',\\'pending\\')">↩ 重置</button>';
        }
        html += '<div class="order-card"><div class="order-header"><div><div class="order-no">'+o.orderNo+'</div><div class="order-time">'+t+'</div>'+contactHtml+'</div><span class="status-badge status-'+o.status+'">'+sl+'</span></div>'+items+'<div class="order-footer"><span class="order-total">¥'+o.total+'</span><div class="action-btns">'+actions+'</div></div></div>';
    }
    html += '</div>';
    document.getElementById('content').innerHTML = html;
}

// Filter buttons
document.getElementById('filterBar').addEventListener('click', (e) => {
    if (!e.target.classList.contains('filter-btn')) return;
    currentFilter = e.target.dataset.filter;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    loadOrders();
});

document.getElementById('refreshBtn').addEventListener('click', loadOrders);
document.getElementById('logoutBtn').addEventListener('click', () => { password=''; localStorage.removeItem('admin_pwd'); showLogin(); });

if (password) { loadOrders(); } else { showLogin(); }
setInterval(() => { if (password) loadOrders(); }, 15000);
</script>
</body>
</html>`;
}

app.listen(PORT, () => {
    console.log(\`🍸 Life In. 鸡尾酒定制系统 → http://localhost:\${PORT}\`);
    console.log(\`🎨 ARK API（图片生成）: \${ARK_API_KEY ? '✅ 已配置' : '❌ 未配置'} | 模型: \${ARK_MODEL}\`);
    console.log(\`💬 Coze API（AI聊天）: \${COZE_API_TOKEN && COZE_BOT_ID ? '✅ 已配置' : '❌ 未配置'} | Bot: \${COZE_BOT_ID || '未设置'}\`);
    console.log(\`📋 管理后台: http://localhost:\${PORT}/admin | 密码: \${ADMIN_PASSWORD}\`);
});
