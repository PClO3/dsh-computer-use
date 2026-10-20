# cu-shot.ps1 - (optional) capture the primary screen to a PNG and/or enumerate
# interactive UI elements of the foreground window (UIA) to a JSON file.
# All output is via files; stdout only carries a one-line status.
#
# Screen capture moved to cu-grab.py (PIL, faster cold start) for
# the dsh-cu-n1 default path. Pass -NoCapture to skip GDI+ here and only run
# the UIA enumeration (that is what index.js does for som:true, in parallel
# with cu-grab.py). Legacy mode (no -NoCapture) still captures, so the old
# invocation keeps working.
#
# 2026-10-16: 枚举实现搬进 cu-uia.ps1（点源加载），本文件只留参数解析 + 截屏 + 调用。
#   原因：常驻服务 cu-uia-serve.ps1 要用**同一份**枚举逻辑，复制一份必然走偏。
#
# !!! MUST stay UTF-8 WITH BOM !!! Windows PowerShell 5.1 reads BOM-less files as ANSI;
#     the GBK decoder then swallows the LF after some CJK chars and turns the next
#     CODE line into part of a comment -- that silently killed the $host_el assignment
#     and made this script enumerate the WHOLE DESKTOP instead of the foreground window.
param(
    [string]$OutPath = "",
    [string]$ElementsPath = "",
    [switch]$NoCapture,
    [string]$Scope = "foreground",
    [string]$Find = ""
)
$ErrorActionPreference = "Stop"

if (-not $NoCapture -and $OutPath -eq "") {
    throw "cu-shot.ps1: -OutPath is required unless -NoCapture is given"
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here "cu-uia.ps1")
Init-CuUia

$bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds

$meta = [ordered]@{
    width  = $bounds.Width
    height = $bounds.Height
}

if (-not $NoCapture) {
    Add-Type -AssemblyName System.Drawing
    $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $g.Dispose()
    $bmp.Save($OutPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $meta.path = $OutPath
}

if ($ElementsPath -ne "") {
    $enumMeta = Invoke-CuUiaEnumeration -ElementsPath $ElementsPath -Scope $Scope -Find $Find
    foreach ($k in $enumMeta.Keys) { $meta[$k] = $enumMeta[$k] }
}

Write-Output ($meta | ConvertTo-Json -Compress -Depth 3)
