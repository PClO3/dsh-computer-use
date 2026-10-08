# cu-shot.ps1 - (optional) capture the primary screen to a PNG and/or enumerate
# interactive UI elements of the foreground window (UIA) to a JSON file.
# All output is via files; stdout only carries a one-line status.
#
# Screen capture moved to cu-grab.py (PIL, faster cold start) for
# the dsh-cu-n1 default path. Pass -NoCapture to skip GDI+ here and only run
# the UIA enumeration (that is what index.js does for som:true, in parallel
# with cu-grab.py). Legacy mode (no -NoCapture) still captures, so the old
# invocation keeps working.
param(
    [string]$OutPath = "",
    [string]$ElementsPath = "",
    [switch]$NoCapture
)
$ErrorActionPreference = "Stop"

if (-not $NoCapture -and $OutPath -eq "") {
    throw "cu-shot.ps1: -OutPath is required unless -NoCapture is given"
}

Add-Type -Namespace Native -Name Dpi -MemberDefinition `
    '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[Native.Dpi]::SetProcessDPIAware() | Out-Null

Add-Type -AssemblyName System.Windows.Forms
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
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes

    Add-Type -Namespace Native -Name Fg -MemberDefinition `
        '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();'

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

    # Interactive elements of the foreground window (fallback: all top windows).
    # 试过 CacheRequest 批量取属性(减少跨进程调用),真机测试读到空属性
    # (PS 5.1 + .NET UIA wrapper 的坑),已回退为逐元素 .Current——实测 536 元素
    # 也就 ~150ms;重窗口的长尾由 cu-grab.py 的 12s 超时降级兜底。
    $host_el = [System.Windows.Automation.AutomationElement]::FromHandle($fgHwnd)
    if ($null -eq $host_el) { $host_el = $root }
    $all = $host_el.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition)

    $INTERACTIVE = @("Button", "Hyperlink", "ListItem", "MenuItem", "TabItem",
        "TreeItem", "Edit", "Document", "ComboBox", "CheckBox", "RadioButton",
        "ToggleButton", "DataItem", "Spinner", "Slider", "Custom")
    $elements = New-Object System.Collections.ArrayList
    $seen = @{}
    foreach ($el in $all) {
        if ($elements.Count -ge 60) { break }
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
        [void]$elements.Add([ordered]@{
            i = $elements.Count + 1; name = $name; type = $ctype; x = $cx; y = $cy
        })
    }

    $meta.elements = $elements.Count
    $ui = [ordered]@{
        screen  = "primary $($bounds.Width)x$($bounds.Height)"
        windows = $windows
        elements = $elements
    }
    [System.IO.File]::WriteAllText($ElementsPath, ($ui | ConvertTo-Json -Depth 4),
        (New-Object System.Text.UTF8Encoding($false)))
}

Write-Output ($meta | ConvertTo-Json -Compress -Depth 3)
