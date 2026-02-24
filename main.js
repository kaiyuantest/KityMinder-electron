const { app, BrowserWindow, Menu, shell, ipcMain, dialog } = require('electron');
const path = require('path');
const express = require('express');
const fs = require('fs');
const fsPromises = fs.promises;
const crypto = require('crypto');
const { machineId } = require('node-machine-id');
let currentMainWindow = null; // 当前的主窗口
let allWindows = []; // 存储所有窗口引用
let server = null; // Express服务器实例
// 接口配置 - 请修改为你的实际接口地址
const INTERNAL_KAMI_API = 'https://aa.xxxx.com/index.php?route=datakami'; // 内部卡密验证接口
const VALIDATION_API = 'https://bb.xxxx.com/index.php?route=validateactivation'; // 30天验证接口
const EXTERNAL_KAMI_API = 'https://cc.xxxx.com/api/UserLoginkm'; // 外部卡密接口
// localStorage键名
const STORAGE_KEYS = {
    INVALID_FLAG: 'activation_invalid',
    LAST_CHECK: 'last_server_check',
    FORCE_RECHECK: 'force_recheck',
    KEY_DATA: 'simulated_key_data' // 无权限时模拟keyData
};
// 获取许可证文件路径（在用户主目录下，名为 'swdtlicensedaochu.key'）
function getLicensePath() {
    return path.join(app.getPath('home'), 'swdtlicensedaochu.key');
}
// 检测文件权限
async function testFilePermission() {
    try {
        const testFile = path.join(app.getPath('home'), 'test_permission.tmp');
        fs.writeFileSync(testFile, 'test');
        fs.unlinkSync(testFile);
        return true;
    } catch (error) {
        // console.log('文件权限测试失败:', error.message);
        return false;
    }
}
// localStorage相关函数（优化：确保窗口加载后执行）
async function ensureStorageReady() {
    return new Promise((resolve) => {
        if (currentMainWindow && currentMainWindow.webContents) {
            const checkLoaded = () => {
                currentMainWindow.webContents.executeJavaScript('document.readyState').then(state => {
                    if (state === 'complete') {
                        resolve();
                    } else {
                        currentMainWindow.webContents.once('did-finish-load', checkLoaded);
                    }
                });
            };
            checkLoaded();
        } else {
            resolve(); // 无窗口时跳过
        }
    });
}
async function getStorageValue(key, defaultValue = null) {
    await ensureStorageReady();
    try {
        if (currentMainWindow && currentMainWindow.webContents) {
            const value = await currentMainWindow.webContents.executeJavaScript(
                `localStorage.getItem('${key}') ? JSON.parse(localStorage.getItem('${key}')) : ${JSON.stringify(defaultValue)}`
            );
            return value;
        }
    } catch (error) {
        console.error('获取localStorage失败:', error);
    }
    return defaultValue;
}
async function setStorageValue(key, value) {
    await ensureStorageReady();
    try {
        if (currentMainWindow && currentMainWindow.webContents) {
            await currentMainWindow.webContents.executeJavaScript(
                `localStorage.setItem('${key}', '${JSON.stringify(value)}')`
            );
        }
    } catch (error) {
        console.error('设置localStorage失败:', error);
    }
}
// 解析key文件内容
function parseKeyContent(content) {
    try {
        // 先尝试Base64解码
        let decoded;
        try {
            decoded = Buffer.from(content, 'base64').toString('utf8');
        } catch {
            decoded = content; // 如果不是Base64编码，直接使用原内容
        }
        const parts = decoded.split(':');
        if (parts.length !== 5) {
            return null;
        }
        return {
            status: parts[0],
            deviceId: parts[1],
            activationTime: parseInt(parts[2]),
            lastCheckTime: parseInt(parts[3]),
            kamiType: parts[4]
        };
    } catch (error) {
        console.error('解析key内容失败:', error);
        return null;
    }
}
// 生成key文件内容
function generateKeyContent(deviceId, activationTime, kamiType) {
    const content = `VALID:${deviceId}:${activationTime}:${activationTime}:${kamiType}`;
    return Buffer.from(content).toString('base64');
}
// 更新key文件的最后检测时间（或localStorage）
async function updateKeyLastCheckTime(hasPermission) {
    const currentTime = Math.floor(Date.now() / 1000);
    try {
        if (hasPermission) {
            const licensePath = getLicensePath();
            if (fs.existsSync(licensePath)) {
                const content = fs.readFileSync(licensePath, 'utf8');
                const keyData = parseKeyContent(content);
                if (keyData) {
                    const updatedContent = `VALID:${keyData.deviceId}:${keyData.activationTime}:${currentTime}:${keyData.kamiType}`;
                    const encodedContent = Buffer.from(updatedContent).toString('base64');
                    fs.writeFileSync(licensePath, encodedContent);
                    // console.log('更新key文件检测时间成功');
                    return true;
                }
            }
        } else {
            // 无权限：更新localStorage
            await setStorageValue(STORAGE_KEYS.LAST_CHECK, currentTime);
            // console.log('使用localStorage更新检测时间');
            return true;
        }
    } catch (error) {
        console.error('更新检测时间失败:', error);
        return false;
    }
    return false;
}
// 删除或标记激活文件失效
async function invalidateActivation(hasPermission) {
    try {
        if (hasPermission) {
            const licensePath = getLicensePath();
            if (fs.existsSync(licensePath)) {
                fs.unlinkSync(licensePath);
                // console.log('删除激活文件成功');
                return true;
            }
        } else {
            // 无权限：标记localStorage
            await setStorageValue(STORAGE_KEYS.INVALID_FLAG, true);
            await setStorageValue(STORAGE_KEYS.KEY_DATA, null); // 清空模拟key
            // console.log('使用localStorage标记激活失效');
            return true;
        }
    } catch (error) {
        console.error('删除激活文件失败:', error);
        // 降级
        await setStorageValue(STORAGE_KEYS.INVALID_FLAG, true);
        await setStorageValue(STORAGE_KEYS.KEY_DATA, null);
        return false;
    }
    return false;
}
// 30天服务器验证
async function performServerValidation(keyContent, activationTime) {
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(VALIDATION_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ key_content: keyContent, activation_time: activationTime }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        if (!response.ok) {
            throw new Error(`HTTP错误: ${response.status}`);
        }
        const data = await response.json();
        // console.log('服务器验证结果:', data);
        return {
            success: data.success,
            action: data.action || 'continue',
            message: data.message || '验证完成'
        };
    } catch (error) {
        console.error('服务器验证失败:', error);
        // 网络错误时返回继续使用的结果（更新时间）
        return {
            success: true,
            action: 'continue',
            message: '网络异常，允许继续使用'
        };
    }
}
// 处理获取设备ID的IPC调用
ipcMain.handle('get-device-id', async () => {
    return await machineId(); // 用全ID匹配PHP
});
// 处理检查激活的IPC调用
ipcMain.handle('check-activation', async () => {

    try {
        const hasPermission = await testFilePermission();
        const licensePath = getLicensePath();
        let keyData = null;
        let isUsingStorage = false;
        // 优先文件，无权限 fallback localStorage
        if (fs.existsSync(licensePath) && hasPermission) {
            const licenseContent = fs.readFileSync(licensePath, 'utf8');
            keyData = parseKeyContent(licenseContent);
        } else if (!hasPermission) {
            keyData = await getStorageValue(STORAGE_KEYS.KEY_DATA);
            isUsingStorage = true;
        }
        if (!keyData) {
            // console.log('激活文件不存在或无效');
            return false;
        }
        // 检查localStorage失效标记（无论文件或storage）
        const isInvalid = await getStorageValue(STORAGE_KEYS.INVALID_FLAG, false);
        if (isInvalid) {
            // console.log('标记为失效');
            return false;
        }
        // 基本验证
        const currentDeviceId = await machineId();
        if (keyData.deviceId !== currentDeviceId) {
            // console.log('设备ID不匹配');
            return false;
        }
        // 30天检测逻辑
        const currentTime = Math.floor(Date.now() / 1000);
        let lastCheckTime = keyData.lastCheckTime;
        if (isUsingStorage) {
            lastCheckTime = await getStorageValue(STORAGE_KEYS.LAST_CHECK, keyData.lastCheckTime);
        }
        //过期验证
        const daysSinceLastCheck = Math.floor((currentTime - lastCheckTime) / (24 * 60 * 60));
        // const daysSinceLastCheck = Math.floor((currentTime - lastCheckTime) / 30);
        // console.log(`距离上次检测: ${daysSinceLastCheck} 天`);
        // if (daysSinceLastCheck >= 1) {
        if (daysSinceLastCheck >= 30) {
        //     console.log('需要进行服务器验证');
            const keyContent = isUsingStorage ? generateKeyContent(keyData.deviceId, keyData.activationTime, keyData.kamiType) : fs.readFileSync(licensePath, 'utf8');
            const validationResult = await performServerValidation(keyContent, keyData.activationTime);
            if (validationResult.action === 'invalidate') {
                await invalidateActivation(hasPermission);
                return false;
            } else {
                // 更新时间（文件或storage）
                await updateKeyLastCheckTime(hasPermission);
                if (isUsingStorage) {
                    await setStorageValue(STORAGE_KEYS.KEY_DATA, { ...keyData, lastCheckTime: currentTime });
                }
                return true;
            }
        } else {
            // console.log('30天内，直接通过验证');
            return true;
        }
    } catch (error) {
        console.error('激活检查失败:', error);
        // 异常时更新时间并允许使用
        const hasPermission = await testFilePermission();
        await updateKeyLastCheckTime(hasPermission);
        return true;
    }
});


//测试专用卡密
// async function validateInternalKami(kami, logs) {
//     // 检查时间限制 - 2025年11月2日
//     const currentDate = new Date();
//     const limitDate = new Date('2025-11-02T00:00:00'); // 2025年11月2日 00:00:00
//
//     if (currentDate >= limitDate) {
//         // console.log('时间限制已到期，验证失败');
//         return {
//             success: false,
//             message: '验证服务已过期',
//             rawData: {
//                 success: false,
//                 message: '验证服务已过期'
//             }
//         };
//     }
//
//     // 时间未到期，返回成功
//     return {
//         success: true,
//         message: '卡密验证成功',
//         rawData: {
//             success: true,
//             message: '卡密验证成功'
//         }
//     };
// }

// 验证内部卡密
async function validateInternalKami(kami, logs) {
    // logs.push('=== 内部卡密验证开始 ===');
    // console.log('=== 内部卡密验证开始 ===');
    // logs.push(`请求URL: ${INTERNAL_KAMI_API}`);
    // console.log('请求URL:', INTERNAL_KAMI_API);
    // logs.push(`发送数据: ${JSON.stringify({ action: 'verify', km: kami })}`);
    console.log('发送数据:', { action: 'verify', km: kami });
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(INTERNAL_KAMI_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ action: 'verify', km: kami }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        const responseText = await response.text();
        // logs.push(`内部原始响应文本: ${responseText}`);
        // console.log('内部原始响应文本:', responseText);

        // logs.push(`内部响应状态: ${response.status}`);
        // console.log('内部响应状态:', response.status);
        // logs.push(`内部响应头: ${JSON.stringify(Object.fromEntries(response.headers.entries()))}`);
        // console.log('内部响应头:', Object.fromEntries(response.headers.entries()));
        if (!response.ok) {
            // logs.push(`内部接口响应错误: ${response.status}`);
            // console.log('内部接口响应错误:', response.status);
            return { success: false, message: '响应错误', rawData: null };
        }
        const data = JSON.parse(responseText);
        // logs.push(`内部验证结果: ${JSON.stringify(data)}`);
        // console.log('内部验证结果:', data);
        // logs.push('=== 内部卡密验证结束 ===');
        // console.log('=== 内部卡密验证结束 ===');
        return {
            success: data.success,  // 直接用boolean true/false
            message: data.message,  // 用message，不是msg
            rawData: data
        };
    } catch (error) {
        // logs.push(`内部卡密验证异常: ${error.message}`);
        // console.error('内部卡密验证异常:', error);
        // logs.push('=== 内部卡密验证结束 (失败) ===');
        // console.log('=== 内部卡密验证结束 (失败) ===');
        return { success: false, message: '服务器连接失败', rawData: null };
    }
}
// 验证外部卡密
async function validateExternalKami(kami, deviceId, logs) {
    // logs.push('=== 外部卡密验证开始 (fallback) ===');
    // console.log('=== 外部卡密验证开始 (fallback) ===');
    // logs.push(`请求URL: ${EXTERNAL_KAMI_API}`);
    // console.log('请求URL:', EXTERNAL_KAMI_API);
    // logs.push(`发送数据: ${JSON.stringify({ appid: 10011, km: kami, device: deviceId })}`);
    // console.log('发送数据:', { appid: 10011, km: kami, device: deviceId });
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        const response = await fetch(EXTERNAL_KAMI_API, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ appid: 10011, km: kami, device: deviceId }),
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        const responseText = await response.text(); // 新增: 获取原始文本响应
        // logs.push(`外部原始响应文本: ${responseText}`);
        // console.log('外部原始响应文本:', responseText);
        // logs.push(`外部响应状态: ${response.status}`);
        // console.log('外部响应状态:', response.status);
        const data = JSON.parse(responseText); // 使用文本解析JSON
        // logs.push(`外部API返回数据: ${JSON.stringify(data)}`);
        // console.log('外部API返回数据:', data);
        // logs.push('=== 外部卡密验证结束 ===');
        // console.log('=== 外部卡密验证结束 ===');
        return {
            success: data.msg === '激活成功',
            message: data.msg,
            rawData: data
        };
    } catch (error) {
        // logs.push(`外部卡密验证异常: ${error.message}`);
        // console.error('外部卡密验证异常:', error);
        // logs.push('=== 外部卡密验证结束 (失败) ===');
        // console.log('=== 外部卡密验证结束 (失败) ===');
        return {
            success: false,
            message: '服务器连接失败',
            rawData: null
        };
    }
}
// 处理激活的IPC调用
ipcMain.handle('activate', async (_, km) => {
    const logs = [];
    // logs.push(`=== 激活 IPC 开始 === km: ${km}`);
    // console.log('=== 激活 IPC 开始 ===', { km });
    try {
        const deviceId = await machineId();
        const activationTime = Math.floor(Date.now() / 1000);
        const hasPermission = await testFilePermission();
        const licensePath = getLicensePath();
        // 先尝试内部
        const internalResult = await validateInternalKami(km, logs);
        // logs.push(`内部结果: ${JSON.stringify(internalResult)}`);  // 改用JSON.stringify，避免[object Object]
        // console.log('内部结果:', internalResult);
        if (internalResult && internalResult.success) {  // 改为检查success
            const keyContent = generateKeyContent(deviceId, activationTime, 'INTERNAL');
            if (hasPermission) {
                fs.writeFileSync(licensePath, keyContent);
            } else {
                await setStorageValue(STORAGE_KEYS.KEY_DATA, {
                    status: 'VALID',
                    deviceId,
                    activationTime,
                    lastCheckTime: activationTime,
                    kamiType: 'INTERNAL'
                });
                await setStorageValue(STORAGE_KEYS.INVALID_FLAG, false);
            }
            // logs.push('=== 激活 IPC 结束 (内部成功) ===');
            // console.log('=== 激活 IPC 结束 (内部成功) ===');
            return {
                success: true,
                message: '内部卡密激活成功',
                isInternal: true,
                logs
            };
        }
        // 内部失败，尝试外部
        // logs.push('内部失败，尝试外部');
        // console.log('内部失败，尝试外部');
        const externalResult = await validateExternalKami(km, deviceId, logs);
        // logs.push(`外部结果: ${JSON.stringify(externalResult)}`);
        // console.log('外部结果:', externalResult);
        if (externalResult.success) {
            const keyContent = generateKeyContent(deviceId, activationTime, 'NORMAL');
            if (hasPermission) {
                fs.writeFileSync(licensePath, keyContent);
            } else {
                await setStorageValue(STORAGE_KEYS.KEY_DATA, {
                    status: 'VALID',
                    deviceId,
                    activationTime,
                    lastCheckTime: activationTime,
                    kamiType: 'NORMAL'
                });
                await setStorageValue(STORAGE_KEYS.INVALID_FLAG, false);
            }
            // logs.push('=== 激活 IPC 结束 (外部成功) ===');
            // console.log('=== 激活 IPC 结束 (外部成功) ===');
            return {
                success: true,
                message: externalResult.message,
                isInternal: false,
                logs
            };
        }
        // logs.push('=== 激活 IPC 结束 (失败) ===');
        // console.log('=== 激活 IPC 结束 (失败) ===');
        return { ...externalResult, logs };
    } catch (error) {
        // logs.push(`激活异常: ${error.message}`);
        // console.error('激活异常:', error);
        // logs.push('=== 激活 IPC 结束 (异常) ===');
        // console.log('=== 激活 IPC 结束 (异常) ===');
        return {
            success: false,
            message: error.message,
            isInternal: false,
            logs
        };
    }
});
// 创建菜单模板函数
function createMenuTemplate(window) {
    return [
        {
            label: '导航',
            submenu: [
                {
                    label: '返回',
                    accelerator: 'Alt+Left',
                    click: () => {
                        if (window.webContents.navigationHistory.canGoBack()) {
                            window.webContents.navigationHistory.goBack();
                        }
                    }
                },
                {
                    label: '前进',
                    accelerator: 'Alt+Right',
                    click: () => {
                        if (window.webContents.navigationHistory.canGoForward()) {
                            window.webContents.navigationHistory.goForward();
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: '重新加载',
                    accelerator: 'CmdOrCtrl+R',
                    role: 'reload'
                },
                {
                    label: '开发者工具',
                    role: 'toggleDevTools'
                }
            ]
        }
    ];
}
// 创建右键菜单模板函数
function createContextMenuTemplate(window) {
    return [
        {
            label: '返回',
            click: () => {
                if (window.webContents.navigationHistory.canGoBack()) {
                    window.webContents.navigationHistory.goBack();
                }
            }
        },
        {
            label: '前进',
            click: () => {
                if (window.webContents.navigationHistory.canGoForward()) {
                    window.webContents.navigationHistory.goForward();
                }
            }
        },
        { type: 'separator' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '重新加载', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' }
    ];
}
// 设置窗口为主窗口
function setAsMainWindow(window) {
    currentMainWindow = window;
    const currentTitle = window.getTitle();
    if (!currentTitle.includes('(主窗口)')) {
        window.setTitle(currentTitle + ' (主窗口)');
    }
    allWindows.forEach(win => {
        if (win !== window && !win.isDestroyed()) {
            const title = win.getTitle();
            if (title.includes('(主窗口)')) {
                win.setTitle(title.replace(' (主窗口)', ''));
            }
        }
    });
}
// 添加IPC通信处理 - 处理打开新窗口请求
ipcMain.handle('open-new-window', async (event, noteNumber) => {
    const newWindow = createNewWindow(noteNumber);
    setAsMainWindow(newWindow);
    return true;
});
// 创建新窗口的函数
function createNewWindow(noteNumber = '101') {
    const newWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            webSecurity: false
        },
        show: false,
        backgroundThrottling: false
    });
    setupWindowNavigation(newWindow);
    newWindow.show();
    newWindow.loadURL(`http://localhost:8963/user.html?note=${noteNumber}`);
    allWindows.push(newWindow);
    newWindow.on('close', (event) => {
        const otherWindows = allWindows.filter(win => win !== newWindow && !win.isDestroyed());
        if (newWindow === currentMainWindow && otherWindows.length > 0) {
            if (otherWindows.length > 0) {
                const latestWindow = otherWindows[otherWindows.length - 1];
                setAsMainWindow(latestWindow);
            }
        }
        const index = allWindows.indexOf(newWindow);
        if (index > -1) {
            allWindows.splice(index, 1);
        }
        if (allWindows.filter(win => !win.isDestroyed()).length === 0) {
            if (server) {
                server.close();
            }
            currentMainWindow = null;
            app.quit();
        }
    });
    newWindow.on('focus', () => {
        setAsMainWindow(newWindow);
    });
    return newWindow;
}
// 配置窗口导航功能
function setupWindowNavigation(window) {
    window.webContents.setWindowOpenHandler(({ url }) => {
        if (url.includes('xxxxx.com')) {
            const newWindow = createNewWindow();
            newWindow.loadURL(url);
            setAsMainWindow(newWindow);
            return { action: 'deny' };
        } else if (url === '' || url === 'about:blank') {
            return { action: 'allow' };
        }
        shell.openExternal(url);
        return { action: 'deny' };
    });
    const contextMenuTemplate = createContextMenuTemplate(window);
    const contextMenu = Menu.buildFromTemplate(contextMenuTemplate);
    window.webContents.on('context-menu', () => {
        contextMenu.popup({ window: window });
    });
}
function createWindow() {
    // 创建 Express 服务器（监听 8963 端口）
    const localServer = express();
    const port = 8963;
    const staticPath = path.join(__dirname, 'public');
    // 先配置图片路径
    if (process.env.NODE_ENV === 'development') {
        localServer.use('/resources/img', express.static(path.join(__dirname, 'public/resources/img')));
    } else {
        // 在生产环境中，使用用户数据目录作为图片存储和serving路径
        const userDataPath = app.getPath('userData');
        const prodImagePath = path.join(userDataPath, 'resources/img');
        // 确保目录存在
        fsPromises.mkdir(prodImagePath, { recursive: true }).catch(console.error);
        localServer.use('/resources/img', express.static(prodImagePath));
    }
    // 最后配置 public 目录
    localServer.use(express.static(staticPath));
    // 监听端口，处理端口占用错误
    server = localServer.listen(port, () => {
        // console.log(`Server running at http://localhost:${port}`);
    }).on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`Port ${port} is in use!`);
            app.quit();
        }
    });
    // 创建第一个窗口并设为主窗口
    const firstWindow = createNewWindow('101');
    setAsMainWindow(firstWindow);
    // 设置全局菜单
    const menu = Menu.buildFromTemplate([
        {
            label: '导航',
            submenu: [
                {
                    label: '返回',
                    accelerator: 'Alt+Left',
                    click: () => {
                        const focusedWindow = BrowserWindow.getFocusedWindow();
                        if (focusedWindow && focusedWindow.webContents.navigationHistory.canGoBack()) {
                            focusedWindow.webContents.navigationHistory.goBack();
                        }
                    }
                },
                {
                    label: '前进',
                    accelerator: 'Alt+Right',
                    click: () => {
                        const focusedWindow = BrowserWindow.getFocusedWindow();
                        if (focusedWindow && focusedWindow.webContents.navigationHistory.canGoForward()) {
                            focusedWindow.webContents.navigationHistory.goForward();
                        }
                    }
                },
                { type: 'separator' },
                {
                    label: '重新加载',
                    accelerator: 'CmdOrCtrl+R',
                    role: 'reload'
                },
                {
                    label: '开发者工具',
                    role: 'toggleDevTools'
                }
            ]
        }
    ]);
    Menu.setApplicationMenu(null);
}
// IPC处理器 - 保存本地图片（兼容原有接口）
ipcMain.handle('save-local-image', async (event, arrayBuffer, filename) => {
    try {
        const imagesPath = path.join(__dirname, 'public/resources/img');
        await fsPromises.mkdir(imagesPath, { recursive: true });
        const filePath = path.join(imagesPath, filename);
        await fsPromises.writeFile(filePath, Buffer.from(arrayBuffer));
        return `http://localhost:8963/resources/img/${filename}`;
    } catch (error) {
        console.error('Save local image error:', error);
        throw error;
    }
});
// IPC处理器 - 新的图片保存接口（与前端代码匹配）
ipcMain.handle('save-image-to-local', async (event, data) => {
    let imagesPath;
    if (process.env.NODE_ENV === 'development') {
        imagesPath = path.join(__dirname, 'public/resources/img');
    } else {
        imagesPath = path.join(app.getPath('userData'), 'resources/img');
    }
    try {
        const { filename, buffer, targetDir } = data;
        const finalImagesPath = targetDir || imagesPath;
        await fsPromises.mkdir(finalImagesPath, { recursive: true });
        const filePath = path.join(finalImagesPath, filename);
        const uint8Array = new Uint8Array(buffer);
        await fsPromises.writeFile(filePath, uint8Array);
        // console.log('Image saved successfully:', filePath);
        return { success: true, filePath: filePath };
    } catch (error) {
        console.error('Save image to local error:', error);
        return { success: false, error: error.message };
    }
});
// 添加调试接口 - 获取激活信息
ipcMain.handle('get-activation-info', async () => {
    try {
        const licensePath = getLicensePath();
        if (!fs.existsSync(licensePath)) {
            return { exists: false };
        }
        const content = fs.readFileSync(licensePath, 'utf8');
        const keyData = parseKeyContent(content);
        if (!keyData) {
            return { exists: true, valid: false, reason: '格式无效' };
        }
        const currentTime = Math.floor(Date.now() / 1000);
        const daysSinceActivation = Math.floor((currentTime - keyData.activationTime) / (24 * 60 * 60));
        const daysSinceLastCheck = Math.floor((currentTime - keyData.lastCheckTime) / (24 * 60 * 60));
        return {
            exists: true,
            valid: true,
            kamiType: keyData.kamiType,
            activationDate: new Date(keyData.activationTime * 1000).toLocaleString(),
            lastCheckDate: new Date(keyData.lastCheckTime * 1000).toLocaleString(),
            daysSinceActivation: daysSinceActivation,
            daysSinceLastCheck: daysSinceLastCheck,
            needsServerCheck: daysSinceLastCheck >= 30
        };
    } catch (error) {
        return { exists: false, error: error.message };
    }
});
// 添加强制服务器验证接口（用于调试）
ipcMain.handle('force-server-validation', async () => {
    try {
        const licensePath = getLicensePath();
        if (!fs.existsSync(licensePath)) {
            return { success: false, message: '激活文件不存在' };
        }
        const content = fs.readFileSync(licensePath, 'utf8');
        const keyData = parseKeyContent(content);
        //打印key
        // console.log(content)
        // console.log(keyData.activationTime)
        if (!keyData) {
            return { success: false, message: 'key文件格式无效' };
        }
        const validationResult = await performServerValidation(content, keyData.activationTime);
        const hasPermission = await testFilePermission();
        if (validationResult.action === 'invalidate') {
            await invalidateActivation(hasPermission);
            return {
                success: false,
                message: '激活已失效: ' + validationResult.message,
                invalidated: true
            };
        } else {
            await updateKeyLastCheckTime(hasPermission);
            return {
                success: true,
                message: validationResult.message,
                updated: true
            };
        }
    } catch (error) {
        return { success: false, message: '验证失败: ' + error.message };
    }
});
// 应用启动
app.whenReady().then(createWindow);
// 所有窗口关闭时退出应用
app.on('window-all-closed', () => {
    if (server) {
        server.close();
    }
    if (process.platform !== 'darwin') app.quit();
});
// MacOS 重新激活窗口
app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});