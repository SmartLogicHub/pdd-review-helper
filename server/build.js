import { build } from 'esbuild';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');
const distDir = join(__dirname, 'dist');
const nodeModulesDir = join(__dirname, 'node_modules');

function copyDir(src, dest, { exclude = () => false } = {}) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const source = join(src, name);
    const target = join(dest, name);
    if (exclude(source, name)) continue;
    if (statSync(source).isDirectory()) copyDir(source, target, { exclude });
    else copyFileSync(source, target);
  }
}

function writeStartScript() {
  writeFileSync(join(distDir, 'start.cjs'), [
    "const net = require('net');",
    "const path = require('path');",
    '',
    'function canUsePort(port) {',
    '  return new Promise(resolve => {',
    '    const server = net.createServer();',
    "    server.once('error', () => resolve(false));",
    "    server.once('listening', () => server.close(() => resolve(true)));",
    "    server.listen(port, '127.0.0.1');",
    '  });',
    '}',
    '',
    'async function findPort(start) {',
    '  for (let port = start; port < start + 20; port++) {',
    '    if (await canUsePort(port)) return port;',
    '  }',
    "  throw new Error('3001-3020 端口都被占用，请关闭占用程序后重试');",
    '}',
    '',
    '(async () => {',
    '  const appDir = __dirname;',
    "  process.env.APP_DIR = appDir;",
    "  process.env.IS_PKG = '0';",
    "  process.env.PDD_HELPER_PORT = String(await findPort(Number(process.env.PDD_HELPER_PORT || 3001)));",
    "  console.log('拼多多好评助手启动中...');",
    "  console.log('数据目录: ' + (process.env.PDD_HELPER_DATA_DIR || '%APPDATA%/pdd-review-helper'));",
    "  console.log('如遇登录/验证，请在打开的浏览器中手动完成，程序不会绕过平台风控。');",
    "  require(path.join(appDir, 'server.cjs'));",
    '})().catch(err => {',
    "  console.error('启动失败: ' + err.message);",
    '  process.exit(1);',
    '});',
    '',
  ].join('\r\n'));

  writeFileSync(join(distDir, '启动拼多多评价助手.cmd'), [
    '@echo off',
    'title 拼多多好评助手',
    'cd /d "%~dp0"',
    'echo.',
    'echo   拼多多好评助手',
    'echo.',
    'node.exe start.cjs',
    'echo.',
    'echo   服务已停止。',
    'pause',
    '',
  ].join('\r\n'));

  writeFileSync(join(distDir, '首次运行检查.cmd'), [
    '@echo off',
    'cd /d "%~dp0"',
    'echo 检查 Node 运行时...',
    'node.exe --version',
    'echo.',
    'if not exist public\\index.html echo [错误] 缺少 public\\index.html',
    'if not exist node_modules\\playwright echo [错误] 缺少 Playwright 运行依赖',
    'if not exist 好评例子.txt echo [提示] 未找到模板文件，好评例子.txt 会在首次运行时创建',
    'echo.',
    'echo 检查完成。',
    'pause',
    '',
  ].join('\r\n'));
}

function writePortableReadme() {
  writeFileSync(join(distDir, 'README-便携版.txt'), [
    '拼多多好评助手便携版',
    '',
    '使用方式：',
    '1. 双击“启动拼多多评价助手.exe”。如果 exe 被安全软件拦截，可双击“启动拼多多评价助手.cmd”。',
    '2. 浏览器会自动打开本地页面。',
    '3. 首次使用需要在页面中配置 DeepSeek API Key，并在打开的拼多多商家后台中登录。',
    '4. 批量验收请先使用“批量 Dry-run 验收”，它只打开弹窗、填入回复并关闭，不会提交。',
    '',
    '数据说明：',
    '- API Key、评价数据、截图和登录态写入当前电脑的用户数据目录。',
    '- 本便携包不包含 settings.json、reviews.json、browser-data2、node_modules/.cache。',
    '- 拷贝到另一台电脑后，需要在那台电脑重新登录拼多多并配置 API Key。',
    '',
    '风控说明：',
    '- 可关闭的提示/引导/验证弹窗会尝试关闭。',
    '- 需要滑块、短信、人机、账号安全确认的验证不会绕过，请手动完成后任务会继续。',
    '',
  ].join('\r\n'));
}

function copyRuntimeDependencies() {
  copyFileSync(process.execPath, join(distDir, 'node.exe'));

  const targetNodeModules = join(distDir, 'node_modules');
  mkdirSync(targetNodeModules, { recursive: true });
  for (const packageName of ['playwright', 'playwright-core']) {
    const source = join(nodeModulesDir, packageName);
    if (!existsSync(source)) {
      throw new Error(`缺少 ${packageName}，请先在 server 目录运行 npm install`);
    }
    copyDir(source, join(targetNodeModules, packageName), {
      exclude: (sourcePath, name) => name === '.cache' || sourcePath.includes(`${packageName}\\.cache`),
    });
  }
}

function compileLauncherExe() {
  const sourceFile = join(distDir, 'launcher.cs');
  const exeFile = join(distDir, '启动拼多多评价助手.exe');
  writeFileSync(sourceFile, String.raw`
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;

public static class Launcher
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBox(IntPtr hWnd, string text, string caption, uint type);

    private static void ShowError(string message)
    {
        MessageBox(IntPtr.Zero, message, "拼多多评价助手", 0x00000010);
    }

    public static int Main()
    {
        string dir = Path.GetDirectoryName(Process.GetCurrentProcess().MainModule.FileName);
        string node = Path.Combine(dir, "node.exe");
        string start = Path.Combine(dir, "start.cjs");
        if (!File.Exists(node) || !File.Exists(start))
        {
            ShowError("便携包不完整：缺少 node.exe 或 start.cjs");
            return 1;
        }

        var process = new Process();
        process.StartInfo.FileName = node;
        process.StartInfo.Arguments = "\"" + start + "\"";
        process.StartInfo.WorkingDirectory = dir;
        process.StartInfo.UseShellExecute = false;
        process.StartInfo.CreateNoWindow = true;
        process.StartInfo.WindowStyle = ProcessWindowStyle.Hidden;
        process.Start();
        process.WaitForExit();
        return process.ExitCode;
    }
}
`);

  const powershell = process.env.SystemRoot
    ? join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
  const command = [
    'Add-Type',
    `-Path '${sourceFile.replaceAll("'", "''")}'`,
    `-OutputAssembly '${exeFile.replaceAll("'", "''")}'`,
    '-OutputType WindowsApplication',
  ].join(' ');
  const result = spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    stdio: 'inherit',
  });

  if (existsSync(sourceFile)) unlinkSync(sourceFile);
  if (result.status !== 0 || !existsSync(exeFile)) {
    throw new Error('启动 exe 生成失败，可使用 启动拼多多评价助手.cmd 作为兜底启动器');
  }
}

async function main() {
  console.log('开始构建便携版...');
  if (existsSync(distDir)) rmSync(distDir, { recursive: true, force: true });
  mkdirSync(distDir, { recursive: true });

  await build({
    entryPoints: [join(__dirname, 'index.js')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: join(distDir, 'server.cjs'),
    external: ['playwright'],
    minify: false,
    sourcemap: false,
    banner: {
      js: "if (typeof importMetaUrl === 'undefined') { var importMetaUrl = require('url').pathToFileURL(__filename).href; }",
    },
    define: { 'import.meta.url': 'importMetaUrl' },
  });

  const publicSrc = join(__dirname, 'public');
  if (!existsSync(publicSrc)) throw new Error('缺少 server/public，请先构建前端');
  copyDir(publicSrc, join(distDir, 'public'));

  const templateSrc = join(projectRoot, '好评例子.txt');
  if (existsSync(templateSrc)) copyFileSync(templateSrc, join(distDir, '好评例子.txt'));

  const manifestSrc = join(projectRoot, 'automation-manifest.json');
  if (existsSync(manifestSrc)) copyFileSync(manifestSrc, join(distDir, 'automation-manifest.json'));

  writeStartScript();
  writePortableReadme();
  copyRuntimeDependencies();
  compileLauncherExe();

  console.log('构建完成。');
  console.log(`便携目录: ${distDir}`);
  console.log('双击 “启动拼多多评价助手.exe” 即可启动。');
}

main().catch(err => {
  console.error('构建失败:', err.message);
  process.exit(1);
});
