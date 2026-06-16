const express = require('express');
const path = require('path');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;

// ====== 配置区域 ======
const ARK_API_KEY = process.env.ARK_API_KEY || '';
const ARK_MODEL = process.env.ARK_MODEL || 'doubao-seedream-4-0-250828';
// =======================

app.use(express.json({ limit: '20mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// 健康检查
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        ark_configured: !!ARK_API_KEY
    });
});

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
        console.log(`🎨 生成瓶身样机: ${cocktail_name}`);
        const imageUrl = await callArkImageAPI(prompt, image);
        console.log(`✅ 生成成功`);
        res.json({ image_url: imageUrl });
    } catch (err) {
        console.error('❌ 图片生成失败:', err.message);
        res.status(500).json({ error: `图片生成失败: ${err.message}` });
    }
});

// 7轮迭代经验沉淀的 Prompt
function buildMockupPrompt(name, nameEn, volume, alcohol) {
    const vol = volume || '275ml';
    const alc = alcohol || '16% vol';

    return `Life In.品牌鸡尾酒瓶身定制效果图。一个透明玻璃瓶配原木色软木塞，瓶身中央贴着一张长方形标签。标签的完整背景就是用户上传的这张照片，照片内容完整保留不裁剪不抠图，作为标签的全幅背景。标签顶部边缘有一条窄的半透明深色底条，上面用白色优雅字体写着品牌名"Life In."。标签底部边缘有一条窄的半透明深色底条，上面用白色字体写着产品名"${name}"，下方小字写着"${vol} | ${alc}"。文字只叠加在标签的上下边缘区域，完全不遮挡照片中间的人物或动物等主体内容。瓶子形状为标准圆肩直身透明玻璃瓶，与参考照片中的瓶子形状完全一致不变形。瓶子放在一个有大理石质感的台面上，台面上有少量与鸡尾酒风味相关的水果和植物装饰，背景是柔和的浅色渐变。产品摄影级画质，自然光影，精致质感，高清8K。`;
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
        size: '1024x1024',
        response_format: 'url',
        stream: false,
        watermark: false
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
    console.log(`🎨 ARK API（图片生成）: ${ARK_API_KEY ? '✅ 已配置' : '❌ 未配置'}`);
});
