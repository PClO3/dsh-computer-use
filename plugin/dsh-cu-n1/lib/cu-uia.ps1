# cu-uia.ps1 — UIA 枚举的**共用实现**（被 cu-shot.ps1 与 cu-uia-serve.ps1 点源加载）
#
# 为什么要单独一个文件：枚举逻辑原来只有 cu-shot.ps1 一份。加了常驻服务之后
# 若各写一份，两边会慢慢走偏（尤其"两个上限"和"-Find 在扫描之后过滤"这类细节）。
# 点源加载（. "cu-uia.ps1"）只定义函数、不执行任何东西，两边共用同一份实现。
#
# !!! MUST stay UTF-8 WITH BOM !!! 与 cu-shot.ps1 同因：Windows PowerShell 5.1 把
#     无 BOM 的 .ps1 按系统 ANSI 读，GBK 解码会吞掉部分中文注释后的换行，把下一行
#     代码并进注释 —— 曾因此让前台窗口枚举**静默降级为整个桌面**（已修）。
#     本文件同理：无 BOM ⇒ 代码可能被吞。
#
# 调用约定：先 Init-CuUia（Add-Type，一次即可），再 Invoke-CuUiaEnumeration（每次查询）。

# ── 一次性的类型加载（常驻进程只在启动时做一次；一次性进程每次都要做）──────
function Init-CuUia {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -Namespace Native -Name Dpi -MemberDefinition `
        '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
    Add-Type -Namespace Native -Name Fg -MemberDefinition `
        '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();'
    Add-Type -Namespace Native -Name Tb -MemberDefinition `
        '[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern System.IntPtr FindWindow(string lpClassName, string lpWindowName);'
    # DPI 感知必须在**读任何坐标之前**设好，否则报的是逻辑像素、与 cu_act 的物理像素对不上
    [Native.Dpi]::SetProcessDPIAware() | Out-Null
}

# ── 枚举一次，结果写进 $ElementsPath（UTF-8 无 BOM），返回元信息 hashtable ──
# 参数与 cu-shot.ps1 的命令行参数一一对应。
function Invoke-CuUiaEnumeration {
    param(
        [Parameter(Mandatory = $true)][string]$ElementsPath,
        [string]$Scope = "foreground",
        [string]$Find = ""
    )

    $scope = "$Scope".ToLower()
    if (@("foreground", "taskbar", "desktop") -notcontains $scope) {
        throw "cu-shot.ps1: -Scope 必须是 foreground / taskbar / desktop，收到 '$Scope'"
    }

    $bounds = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $meta = [ordered]@{
        width  = $bounds.Width
        height = $bounds.Height
    }

    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $fgHwnd = [Native.Fg]::GetForegroundWindow()

    # Top-level window titles so the model knows what is open.
    $windows = @()
    $tops = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Children,
        [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($w in $tops) {
        if ($w.Current.IsOffscreen) { continue }
        $r = $w.Current.BoundingRectangle
        if ([Double]::IsInfinity($r.X) -or [Double]::IsInfinity($r.Y) -or $r.Width -le 0) { continue }
        $windows += ,@($w.Current.Name, [int]$r.X, [int]$r.Y)
    }

    # ── 枚举范围 -Scope ────────────────────────────────────────────────────
    # foreground(默认): 前台窗口 ｜ taskbar: 任务栏 ｜ desktop: 整个桌面
    # ★ 为什么需要 taskbar：编码 bug 修好后，前台是应用窗口时枚举的就是那个窗口 ——
    #   于是"点任务栏图标"反而找不到（前台往往正是 dsh 自己）。taskbar 补这个缺口。
    $host_el = $null
    $scopeDesc = ""
    # ⚠️ FromHandle(0) **会抛异常**（"hwnd cannot be IntPtr.Zero or null."），不是返回 null。
    #    前台窗口句柄为 0 是**正常情况**（焦点在桌面、或正在切换窗口的瞬间），
    #    实测踩到过：那一刻整个枚举直接失败（find_text 报"枚举后端失败 exit=1"）。
    #    所以每个 FromHandle 都必须包 try/catch，取不到就退化为桌面根。
    if ($scope -eq "taskbar") {
        $tbHwnd = [Native.Tb]::FindWindow("Shell_TrayWnd", $null)
        if ($tbHwnd -ne [IntPtr]::Zero) {
            try { $host_el = [System.Windows.Automation.AutomationElement]::FromHandle($tbHwnd) } catch { $host_el = $null }
        }
        if ($null -eq $host_el) {
            $host_el = $root
            $scopeDesc = "taskbar(未取到 Shell_TrayWnd，已退化为 desktop)"
        } else {
            $scopeDesc = "taskbar(Shell_TrayWnd)"
        }
    } elseif ($scope -eq "desktop") {
        $host_el = $root
        $scopeDesc = "desktop(整个桌面)"
    } else {
        if ($fgHwnd -ne [IntPtr]::Zero) {
            try { $host_el = [System.Windows.Automation.AutomationElement]::FromHandle($fgHwnd) } catch { $host_el = $null }
        }
        if ($null -eq $host_el) {
            $host_el = $root
            $scopeDesc = "foreground(取不到前台窗口，已退化为 desktop)"
        } else {
            $scopeDesc = "foreground(" + $host_el.Current.ClassName + " / " + $host_el.Current.Name + ")"
        }
    }

    # 试过 CacheRequest 批量取属性(减少跨进程调用),真机测试读到空属性
    # (PS 5.1 + .NET UIA wrapper 的坑),已回退为逐元素 .Current——实测 536 元素
    # 也就 ~150ms;重窗口的长尾由 cu-grab.py 的 12s 超时降级兜底。
    $all = $host_el.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)

    $INTERACTIVE = @("Button", "Hyperlink", "ListItem", "MenuItem", "TabItem",
        "TreeItem", "Edit", "Document", "ComboBox", "CheckBox", "RadioButton",
        "ToggleButton", "DataItem", "Spinner", "Slider", "Custom")
    # ── 上限分两层 ────────────────────────────────────────────────────────
    # SCAN_CAP 是**安全阀**：只防极端窗口把时间和内存拖爆，不是设计上限。
    # OUT_CAP  才是**发给模型的条数**（token 成本在这一层）。
    # 为什么要分开：以前 60 卡在"扫描"上 —— 想找的元素若排在树序后面就永远找不到，
    # 而且模型看不出被截断。现在扫描放开、截断**可见**（totalInteractive / truncated）。
    $SCAN_CAP = 5000
    $OUT_CAP = 60
    $elements = New-Object System.Collections.ArrayList
    $seen = @{}
    $scanned = 0
    $totalInteractive = 0
    $matched = 0
    $earlyExit = $false
    foreach ($el in $all) {
        if ($scanned -ge $SCAN_CAP) { break }
        $scanned++
        try { $cur = $el.Current } catch { continue }
        if ($cur.IsOffscreen) { continue }
        $r = $cur.BoundingRectangle
        if ($r.Width -lt 2 -or $r.Height -lt 2) { continue }
        $ctype = $cur.ControlType.ProgrammaticName -replace "^ControlType\.", ""
        if ($INTERACTIVE -notcontains $ctype) { continue }
        $name = ($cur.Name -replace "\s+", " ").Trim()
        if ($name.Length -gt 40) { $name = $name.Substring(0, 40) }
        if ($name.Length -eq 0 -and $cur.AutomationId.Length -eq 0) { continue }
        $cx = [int]($r.X + $r.Width / 2)
        $cy = [int]($r.Y + $r.Height / 2)
        if ($cx -lt 0 -or $cy -lt 0) { continue }
        if ($cx -ge $bounds.Width -or $cy -ge $bounds.Height) { continue }
        $key = "$name|$ctype|$cx|$cy"
        if ($seen.ContainsKey($key)) { continue }
        $seen[$key] = $true
        $totalInteractive++
        # -Find：按名字子串过滤（大小写不敏感）。**在扫描之后过滤**，所以不会
        # 因为"要找的东西排在树序后面"而漏掉 —— 这正是把上限从扫描挪到输出的意义。
        if ($Find -ne "" -and $name.IndexOf($Find, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
        $matched++
        if ($elements.Count -ge $OUT_CAP) { continue }   # 继续统计，但不再收录
        [void]$elements.Add([ordered]@{
            i = $elements.Count + 1; name = $name; type = $ctype; x = $cx; y = $cy
        })
        # ── 提前退出（只在"没有 -Find 过滤"时）────────────────────────────
        # 不收 -Find 时，收录顺序就是 UIA 树序、且永远不会收录第 61 个 ⇒ 收满 OUT_CAP
        # 之后再往下扫**不可能改变结果**（元素清单已定），只是白花时间。实测 dsh 这类
        # 大窗口有 1548~2719 个后代，逐元素 .Current 的循环是真金白银。
        # ⚠️ 用 -Find 时**绝不能**提前退：匹配项可能排在树序很后面，那正是 find 的意义。
        if ($Find -eq "" -and $elements.Count -ge $OUT_CAP) { $earlyExit = $true; break }
    }

    # truncated 的含义是「**输出被 OUT_CAP 截掉了**」，不是「范围内还有别的元素」。
    # 用了 -Find 时，池子是"匹配数"而不是"全部可交互数" —— 否则匹配到 2 个也会被误报成截断。
    $pool = $totalInteractive
    if ($Find -ne "") { $pool = $matched }
    $isTruncated = ($pool -gt $elements.Count) -or $earlyExit
    $meta.elements = $elements.Count
    $meta.scope = $scope
    $meta.truncated = $isTruncated
    $meta.earlyExit = $earlyExit
    if ($Find -ne "") { $meta.matched = $matched }
    $ui = [ordered]@{
        screen           = "primary $($bounds.Width)x$($bounds.Height)"
        scope            = $scope
        scopeDesc        = $scopeDesc
        find             = $Find
        matched          = $matched
        totalInteractive = $totalInteractive
        truncated        = $isTruncated
        earlyExit        = $earlyExit
        scanCap          = $SCAN_CAP
        outputCap        = $OUT_CAP
        windows          = $windows
        elements         = $elements
    }
    [System.IO.File]::WriteAllText($ElementsPath, ($ui | ConvertTo-Json -Depth 4),
        (New-Object System.Text.UTF8Encoding($false)))
    return $meta
}
