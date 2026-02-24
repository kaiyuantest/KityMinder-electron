const fs = require('fs-extra');
const path = require('path');
const { globSync } = require('glob');
const { obfuscate } = require('javascript-obfuscator');
const cheerio = require('cheerio');

// 配置更详细的混淆参数（可根据需要调整）
const OBFUSCATE_OPTIONS = {
    compact: true,
    controlFlowFlattening: true,
    controlFlowFlatteningThreshold: 0.75,
    numbersToExpressions: true,
    simplify: true,
    stringArrayShuffle: true,
    splitStrings: true,
    stringArrayThreshold: 1,
    deadCodeInjection: true,
    deadCodeInjectionThreshold: 0.4,
    debugProtection: false, // 调试保护可能会影响性能
    disableConsoleOutput: false // 保持 console 输出
};

function processJSFiles(sourceDir, targetDir) {
    console.log('[INFO] 开始处理 JS 文件...');
    const jsFiles = globSync('js/**/*.js', { 
        cwd: sourceDir,
        absolute: true,
        nodir: true
    });
    
    console.log(`[DEBUG] 找到 ${jsFiles.length} 个 JS 文件`);
    
    jsFiles.forEach((file, index) => {
        try {
            const code = fs.readFileSync(file, 'utf8');
            console.log(`[处理中] JS (${index + 1}/${jsFiles.length}) ${path.relative(sourceDir, file)}`);
            
            const obfuscated = obfuscate(code, OBFUSCATE_OPTIONS).getObfuscatedCode();
            const relativePath = path.relative(sourceDir, file);
            const targetPath = path.join(targetDir, relativePath);
            
            fs.ensureDirSync(path.dirname(targetPath));
            fs.writeFileSync(targetPath, obfuscated);
        } catch (err) {
            console.error(`[错误] 处理文件 ${file} 失败:`, err.message);
        }
    });
}

function processHTMLFiles(sourceDir, targetDir) {
    console.log('[INFO] 开始处理 HTML 文件...');
    const htmlFiles = globSync('*.html', { 
        cwd: sourceDir,
        absolute: true,
        nodir: true
    });
    
    console.log(`[DEBUG] 找到 ${htmlFiles.length} 个 HTML 文件`);
    
    htmlFiles.forEach((file, index) => {
        try {
            console.log(`[处理中] HTML (${index + 1}/${htmlFiles.length}) ${path.relative(sourceDir, file)}`);
            const content = fs.readFileSync(file, 'utf8');
            const $ = cheerio.load(content, {
                decodeEntities: false // 保持原始编码
            });
            
            $('script').each(function() {
                const script = $(this);
                if (!script.attr('src') && script.html().trim()) {
                    try {
                        const obfuscated = obfuscate(script.html(), OBFUSCATE_OPTIONS).getObfuscatedCode();
                        script.html(obfuscated);
                    } catch (err) {
                        console.error(`[警告] 内联脚本混淆失败 (${path.basename(file)}):`, err.message);
                    }
                }
            });
            
            const relativePath = path.relative(sourceDir, file);
            const targetPath = path.join(targetDir, relativePath);
            
            fs.ensureDirSync(path.dirname(targetPath));
            fs.writeFileSync(targetPath, $.html());
        } catch (err) {
            console.error(`[错误] 处理文件 ${file} 失败:`, err.message);
        }
    });
}

function copyOtherFiles(sourceDir, targetDir) {
    console.log('[INFO] 开始复制其他文件...');
    const allFiles = globSync('**/*', { 
        cwd: sourceDir,
        absolute: true,
        nodir: true,
        ignore: ['**/*.js', '**/*.html']
    });
    
    console.log(`[DEBUG] 找到 ${allFiles.length} 个其他文件`);
    
    allFiles.forEach((file, index) => {
        try {
            const relativePath = path.relative(sourceDir, file);
            const targetPath = path.join(targetDir, relativePath);
            
            console.log(`[复制中] (${index + 1}/${allFiles.length}) ${relativePath}`);
            fs.ensureDirSync(path.dirname(targetPath));
            fs.copyFileSync(file, targetPath);
        } catch (err) {
            console.error(`[错误] 复制文件 ${file} 失败:`, err.message);
        }
    });
}

// 主流程
(async () => {
    try {
        const sourceDir = path.resolve(__dirname, 'public');
        const targetDir = path.resolve(__dirname, 'public_obfuscated');
        
        console.log(`[初始化] 源目录: ${sourceDir}`);
        console.log(`[初始化] 目标目录: ${targetDir}`);
        
        // 清空目标目录
        if (fs.existsSync(targetDir)) {
            console.log('[清理] 清空目标目录');
            fs.emptyDirSync(targetDir);
        }
        
        // 执行处理流程
        processJSFiles(sourceDir, targetDir);
        processHTMLFiles(sourceDir, targetDir);
        copyOtherFiles(sourceDir, targetDir);
        
        console.log('[完成] 混淆处理完成！');
    } catch (err) {
        console.error('[致命错误] 处理失败:', err);
        process.exit(1);
    }
})();