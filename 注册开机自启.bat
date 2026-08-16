@echo off
chcp 65001 >nul
title AI深度量化 - 注册开机自启
echo.
echo   ================================================
echo     AI深度量化 - 注册开机自启（可选）
echo   ================================================
echo.
echo   注册后，每次登录 Windows 都会自动在后台启动网站服务，
echo   之后双击「AI深度量化-打开网站.url」即可直接进入网站。
echo.
echo   注意：如果以后移动了项目文件夹，需要重新运行本脚本。
echo.

set "PROJ=%~dp0"
set "STARTUP=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
set "TARGET=%STARTUP%\AI深度量化-开机启动.bat"

(
echo @echo off
echo cd /d "%PROJ%"
echo start "AI深度量化服务" /min cmd /c "node server\index.cjs"
) > "%TARGET%"

if exist "%TARGET%" (
    echo   [完成] 开机自启已注册：
    echo     %TARGET%
    echo.
    echo   立即测试自启脚本（会静默启动服务，不影响本窗口）...
    call "%TARGET%"
    echo   [完成] 服务已在后台启动，稍等几秒后双击「AI深度量化-打开网站.url」即可访问。
) else (
    echo   [错误] 注册失败，请检查权限后重试。
)
echo.
pause
