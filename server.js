const express = require('express');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

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

// ====== AI 聊天（Coze Bot API） ======
app.post('/api/chat', async (req, res) => {
    const { message, conversation_id, user_id } = req.body;

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
        console.log(`💬 Coze Chat: "${message.slice(0, 30)}..."`);
        const result = await callCozeChat(message, conversation_id, user_id);
        console.log(`✅ AI回复成功`);
        res.json(result);
    } catch (err) {
        console.error('❌ Coze Chat失败:', err.message);
        res.status(500).json({ error: `AI回复失败: ${err.message}`, fallback: true });
    }
});

// Coze Bot API 调用（非流式 + 轮询）
function callCozeChat(message, conversationId, userId) {
    return new Promise((resolve, reject) => {
        const reqBody = JSON.stringify({
            bot_id: COZE_BOT_ID,
            user_id: userId || 'web_user',
            stream: false,
            auto_save_history: true,
            ...(conversationId ? { conversation_id: conversationId } : {}),
            additional_messages: [
                { role: 'user', content: message, content_type: 'text' }
            ]
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

app.listen(PORT, () => {
    console.log(`🍸 Life In. 鸡尾酒定制系统 → http://localhost:${PORT}`);
    console.log(`🎨 ARK API（图片生成）: ${ARK_API_KEY ? '✅ 已配置' : '❌ 未配置'} | 模型: ${ARK_MODEL}`);
    console.log(`💬 Coze API（AI聊天）: ${COZE_API_TOKEN && COZE_BOT_ID ? '✅ 已配置' : '❌ 未配置'} | Bot: ${COZE_BOT_ID || '未设置'}`);
});
