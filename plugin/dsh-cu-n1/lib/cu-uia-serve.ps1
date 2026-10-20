# cu-uia-serve.ps1 — **常驻** UIA 服务（2026-10-16 新增）
#
# 解决什么（实测数字）：
#     powershell.exe 空启动          493 / 535 / 538 ms
#     启动 + -File 解析整个脚本       ~1468 ms（≈ 启动 500ms + 解析/加载 ~900ms）
#     UIA 枚举本身                    24 + 9 ms（小窗口；大窗口据代码注释 150~500ms）
#   ⇒ 每次调用里 **约 1 秒花在"起进程 + 加载程序集 + 解析脚本"上**，与枚举无关。
#   常驻之后这笔只在启动那一次付，之后每次只剩枚举本身。
#
# ── 通信协议：**文件队列 + FileSystemWatcher**（刻意不用 stdin/stdout 管道）────
#   为什么不用管道：Node 与 PowerShell 之间的管道要走控制台代码页，中文关键词
#   （"微信"/"开始"）与 UIA 读回来的中文元素名都可能被搞坏；而且管道方案在受限
#   环境下**根本起不来**（实测 Node 侧 `spawn` 带 pipe 直接 EPERM）。
#   文件方案：编码由**调用方显式指定 UTF-8**，与代码页无关，也不依赖管道。
#
#   · 请求：<QueueDir>\req-<id>.json
#       { "elementsPath": "<结果写哪>", "scope": "foreground|taskbar|desktop", "find": "关键词" }
#   · 应答：<QueueDir>\res-<id>.json
#       { "ok": true, ...meta }  或  { "ok": false, "error": "..." }
#     （id 取自请求文件名，Node 只认自己那个 id，天然不会串台）
#   · 心跳：<QueueDir>\heartbeat.txt —— 父进程每 10s 摸一次；超过 HeartbeatStaleSec
#     没动过 ⇒ 父进程没了 ⇒ **自杀**（不留孤儿进程）。
#   · 启动时扫一遍队列：把"进程还没起来时写下的请求"补做掉（不然第一个请求会白等）。
#
# !!! MUST stay UTF-8 WITH BOM !!! 同 cu-shot.ps1：无 BOM 时 PS 5.1 按 ANSI 读，
#     GBK 解码会吞掉中文注释后的换行、把下一行代码并进注释（已修）。
param(
    [Parameter(Mandatory = $true)][string]$QueueDir,
    [int]$HeartbeatStaleSec = 45
)
$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $here "cu-uia.ps1")
Init-CuUia

if (-not (Test-Path $QueueDir)) { New-Item -ItemType Directory -Path $QueueDir -Force | Out-Null }

$utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-JsonFile([string]$p, $obj) {
    [System.IO.File]::WriteAllText($p, ($obj | ConvertTo-Json -Compress -Depth 5), $utf8)
}

# 处理一个请求文件；无论如何都要产出 res-<id>.json（否则 Node 会一直等）
function Invoke-OneRequest([string]$reqPath) {
    $name = [System.IO.Path]::GetFileName($reqPath)          # req-<id>.json
    $id = $name.Substring(4, $name.Length - 4 - 5)           # 去掉 "req-" 与 ".json"
    $resPath = Join-Path $QueueDir "res-$id.json"
    try {
        $req = [System.IO.File]::ReadAllText($reqPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        $meta = Invoke-CuUiaEnumeration -ElementsPath $req.elementsPath -Scope "$($req.scope)" -Find "$($req.find)"
        $out = [ordered]@{ ok = $true }
        foreach ($k in $meta.Keys) { $out[$k] = $meta[$k] }
        Write-JsonFile $resPath $out
    } catch {
        Write-JsonFile $resPath ([ordered]@{
            ok = $false; error = "$($_.Exception.GetType().Name): $($_.Exception.Message)"
        })
    } finally {
        Remove-Item -LiteralPath $reqPath -Force -ErrorAction SilentlyContinue
    }
}

[Console]::Out.WriteLine("READY")

# ── 事件驱动 + 心跳兜底 ────────────────────────────────────────────────────
$watcher = New-Object System.IO.FileSystemWatcher
$watcher.Path = (Resolve-Path $QueueDir).Path
$watcher.Filter = "req-*.json"
$watcher.NotifyFilter = [System.IO.NotifyFilters]::FileName
$watcher.EnableRaisingEvents = $true

$hb = Join-Path $QueueDir "heartbeat.txt"
$lastSeen = if (Test-Path $hb) { (Get-Item $hb).LastWriteTime } else { Get-Date }

# 启动补做：进程还没起来时写下的请求
Get-ChildItem -Path $QueueDir -Filter "req-*.json" -ErrorAction SilentlyContinue |
    Sort-Object Name | ForEach-Object { Invoke-OneRequest $_.FullName }

$stop = $false
try {
    while (-not $stop) {
        # WaitForChanged 会阻塞；给 2s 超时以便定期查心跳（不能无限阻塞）
        $c = $watcher.WaitForChanged([System.IO.WatcherChangeTypes]::Created, 2000)
        if (-not $c.TimedOut) {
            $p = Join-Path $QueueDir $c.Name
            # 文件可能还在写 —— 重试几次直到能读出来
            for ($i = 0; $i -lt 20; $i++) {
                if (-not (Test-Path $p)) { break }
                try { [void][System.IO.File]::ReadAllText($p, [System.Text.Encoding]::UTF8); break }
                catch { Start-Sleep -Milliseconds 25 }
            }
            Invoke-OneRequest $p
        }
        # 心跳：父进程没了就自杀
        if (Test-Path $hb) {
            $t = (Get-Item $hb).LastWriteTime
            if ($t -gt $lastSeen) { $lastSeen = $t }
        }
        if (((Get-Date) - $lastSeen).TotalSeconds -gt $HeartbeatStaleSec) {
            [Console]::Out.WriteLine("BYE heartbeat-stale")
            $stop = $true
        }
    }
} finally {
    $watcher.EnableRaisingEvents = $false
    $watcher.Dispose()
}
