# SPDX-License-Identifier: MIT
# Copyright (c) 2026 anionex; Windows adaptations copyright (c) 2026 e-Mate contributors.
# Incorporates limited MIT-licensed primitives copyright (c) 2026 jing-hy from
# jing-hy/computer-user@2fbf383b49fe08e466d4d1caba659fb42b61de6b. Full notices: ../../LICENSE and ../../SOURCE.md.
# Adapted only from src/input.ps1 (bounded key-name mapping) and src/capture.ps1
# (DPI awareness), with capture restricted to the exact bound HWND and host path.
# Fixed JSON stdin/stdout protocol; no model-selected command or path.
$ErrorActionPreference = 'Stop'
try {
  $utf8 = [System.Text.UTF8Encoding]::new($false)
  [Console]::InputEncoding = $utf8
  [Console]::OutputEncoding = $utf8
  $OutputEncoding = $utf8
} catch {
  [Console]::Error.WriteLine('Windows helper UTF-8 stream initialization failed')
  exit 2
}

function Reply-Ok($value) { [Console]::Out.WriteLine((ConvertTo-Json -Depth 40 -Compress @{ protocolVersion=2; requestId=$script:requestId; ok=$true; value=$value })); [Console]::Out.Flush() }
# Only fixed categories cross the public error boundary; native messages may contain private paths.
function Get-BlockedReason([string]$message) {
  switch -Regex ($message) {
    '^unsupported targeted (key|modifiers);' { return 'unsupported-key' }
    '^target (keyboard control unavailable|control does not support reliable background messages)$' { return 'unsupported-control' }
    '^background raw pointer input is unavailable for this target$' { return 'background-pointer' }
    '^(UIA (Invoke|Toggle|SelectionItem|ExpandCollapse|Scroll)Pattern unavailable|writable UIA ValuePattern unavailable|enabled UIA target unavailable|unsupported UIA semantic action|UI Automation root unavailable)$' { return 'uia-unavailable' }
    '^(preserve focus policy denies AXRaise|targeted pointer policy is required|coordinate fallback was not explicitly selected|configured activation policy denies fallback while target is not foreground)$' { return 'focus-policy' }
    '^(locked or noninteractive Windows session|secure desktop or locked session is active|unsupported RDP/session transition)$' { return 'desktop-unavailable' }
    '^(target executable identity unavailable|target integrity authority unavailable|elevated/UIPI target is not supported)' { return 'integrity-unavailable' }
    '^(minimized target window cannot be captured|exact target window capture unavailable)$' { return 'capture-unavailable' }
  }
  return $null
}
function Reply-Fail([string]$code, [string]$message) {
  $errorBody=@{ code=$code; message=$message.Substring(0, [Math]::Min(1000, $message.Length)) }
  $reason=Get-BlockedReason $message
  if($null-ne$reason){$errorBody.code='COMPUTER_ACTION_BLOCKED';$errorBody.reason=$reason}
  [Console]::Out.WriteLine((ConvertTo-Json -Compress @{ protocolVersion=2; requestId=$script:requestId; ok=$false; error=$errorBody })); [Console]::Out.Flush()
}
function Assert-Int($value, [int64]$min, [int64]$max, [string]$name) { if ($null -eq $value -or [int64]$value -lt $min -or [int64]$value -gt $max) { throw "$name is out of bounds" }; return [int64]$value }

try {
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing -ErrorAction Stop
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EmateWin32 {
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO { public int cbSize; public uint flags; public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret; public RECT rcCaret; }
  [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, System.Text.StringBuilder name, int count);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetProcessDpiAwarenessContext(IntPtr context);
  public static string ClassName(IntPtr hwnd) { var name=new System.Text.StringBuilder(256); if(GetClassName(hwnd,name,256)==0)throw new System.ComponentModel.Win32Exception();return name.ToString(); }
  [DllImport("user32.dll", SetLastError=true)] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr data);
  [DllImport("user32.dll", SetLastError=true)] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", SetLastError=true)] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
  [DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int cls, out int value, int size, out int returned);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  public static bool IsElevated(uint pid) { IntPtr p=OpenProcess(0x1000,false,pid),t=IntPtr.Zero; if(p==IntPtr.Zero)throw new System.ComponentModel.Win32Exception(); try { if(!OpenProcessToken(p,8,out t))throw new System.ComponentModel.Win32Exception(); int v,n; if(!GetTokenInformation(t,20,out v,4,out n))throw new System.ComponentModel.Win32Exception(); return v!=0; } finally { if(t!=IntPtr.Zero)CloseHandle(t);CloseHandle(p); } }
  public static bool InputDesktopAvailable() { IntPtr d=OpenInputDesktop(0,false,0x0100); if(d==IntPtr.Zero)return false; return CloseDesktop(d); }
  public static long Pack(int x,int y) { return ((uint)(y & 0xffff) << 16) | (uint)(x & 0xffff); }
  public static string ReadRequest(System.IO.TextReader input) { var text=new System.Text.StringBuilder(); int c;while((c=input.Read())!=-1){if(c==10)return text.ToString();if(text.Length>=262144)throw new InvalidOperationException("request exceeds protocol limit");text.Append((char)c);}return text.Length==0?null:text.ToString(); }
  public static bool Send(IntPtr h,uint m,long w,long l) { IntPtr r; return SendMessageTimeout(h,m,(IntPtr)w,(IntPtr)l,2,2000,out r)!=IntPtr.Zero; }
}
'@ -ErrorAction Stop
if (-not [EmateWin32]::SetProcessDpiAwarenessContext([IntPtr](-4))) { throw 'per-monitor v2 DPI authority unavailable' }
} catch { [Console]::Error.WriteLine('Windows UI Automation/Win32 authority unavailable'); exit 2 }

function Assert-Interactive {
  if (-not [Environment]::UserInteractive) { throw 'locked or noninteractive Windows session' }
  if (-not [EmateWin32]::InputDesktopAvailable()) { throw 'secure desktop or locked session is active' }
  $current = [System.Diagnostics.Process]::GetCurrentProcess()
  $active = [EmateWin32]::WTSGetActiveConsoleSessionId()
  if ($active -ne 0xffffffff -and $current.SessionId -ne $active) { throw 'unsupported RDP/session transition' }
}
function Get-Health {
  $uia='unavailable'; $capture='unavailable'
  try { $root=[Windows.Automation.AutomationElement]::RootElement; if($null-eq$root){throw 'UI Automation desktop root unavailable'}; $null=$root.Current.Name; $uia='granted' } catch { $uia='unavailable' }
  try { $h=[EmateWin32]::GetForegroundWindow(); $null=Get-App $h; $bitmap=Capture-Bitmap $h (Get-Frame $h); $bitmap.Dispose(); $capture='granted' } catch { $capture='unavailable' }
  return @{helperVersion='1.0.0';accessibility=$uia;screenRecording=$capture}
}
function Get-Frame([IntPtr]$hwnd) {
  $r = New-Object EmateWin32+RECT
  if (-not [EmateWin32]::GetWindowRect($hwnd, [ref]$r)) { throw "GetWindowRect failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  $w = $r.Right-$r.Left; $h=$r.Bottom-$r.Top
  if ($w -le 0 -or $h -le 0 -or $w -gt 32768 -or $h -gt 32768) { throw 'target window frame is invalid' }
  return [ordered]@{ x=$r.Left; y=$r.Top; width=$w; height=$h }
}
function Get-App([IntPtr]$hwnd) {
  [uint32]$targetProcessId=0
  if ([EmateWin32]::GetWindowThreadProcessId($hwnd,[ref]$targetProcessId) -eq 0 -or $targetProcessId -eq 0) { throw "GetWindowThreadProcessId failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  $process=[Diagnostics.Process]::GetProcessById([int]$targetProcessId)
  try { $path=$process.MainModule.FileName; $start=$process.StartTime.ToUniversalTime().Ticks.ToString(); $name=$process.ProcessName }
  catch { throw 'target executable identity unavailable (elevated/UIPI target may require unavailable authority)' }
  try { if ([EmateWin32]::IsElevated($targetProcessId)) { throw 'elevated/UIPI target is not supported' } } catch { throw "target integrity authority unavailable: $($_.Exception.Message)" }
  return [ordered]@{ bundleId=$path.ToLowerInvariant(); pid=[int]$targetProcessId; name=$name; executablePath=$path; processStartTime=$start; windowId=$hwnd.ToInt64() }
}
function Same-App($expected,$actual) {
  return ([int]$expected.pid -eq [int]$actual.pid -and [string]$expected.bundleId -ceq [string]$actual.bundleId -and [string]$expected.executablePath -ceq [string]$actual.executablePath -and [string]$expected.processStartTime -ceq [string]$actual.processStartTime -and [int64]$expected.windowId -eq [int64]$actual.windowId)
}
function Get-Windows {
  $rows=New-Object System.Collections.Generic.List[object]
  $callback=[EmateWin32+EnumWindowsProc]{ param($h,$unused) if ([EmateWin32]::IsWindowVisible($h)) { try { $f=Get-Frame $h; if ($f.width -gt 0 -and $f.height -gt 0) { $rows.Add($h) } } catch {} }; return $true }
  if (-not [EmateWin32]::EnumWindows($callback,[IntPtr]::Zero)) { throw "EnumWindows failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())" }
  return $rows.ToArray()
}
function Resolve-App($selector) {
  $matches=@()
  foreach($h in Get-Windows) { try { $a=Get-App $h; if (($null -ne $selector.pid -and $a.pid -eq [int]$selector.pid) -or ($selector.bundleId -and ($a.bundleId -ceq [string]$selector.bundleId -or $a.executablePath -ceq [string]$selector.bundleId)) -or ($selector.name -and $a.name -ceq [string]$selector.name)) { $matches += ,@($h,$a) } } catch {} }
  if ($matches.Count -ne 1) { throw "application selector must resolve to exactly one visible HWND; found $($matches.Count)" }
  return $matches[0][1]
}
function Assert-Target($app,[IntPtr]$hwnd) {
  if (-not [EmateWin32]::IsWindow($hwnd)) { throw 'target HWND is missing or replaced' }
  $actual=Get-App $hwnd
  if (-not (Same-App $app $actual)) { throw 'target executable/PID/start-time/HWND identity changed' }
  return $actual
}
function Element-String($element,[string]$property,[int]$max=4096) {
  try { $v=[string]$element.GetCachedPropertyValue([Windows.Automation.AutomationElement]::$property,$true); if ($v.Length -gt $max) { return $v.Substring(0,$max) }; return $v } catch { return '' }
}
function Get-Tree([IntPtr]$hwnd,[int]$maxNodes,[int]$maxDepth,[int]$maxTextBytes) {
  # Batch properties only for this fresh observation; no element cache survives it.
  $cache=New-Object Windows.Automation.CacheRequest;$cache.TreeScope=[Windows.Automation.TreeScope]::Element
  foreach($name in @('ControlTypeProperty','NameProperty','AutomationIdProperty','BoundingRectangleProperty','IsEnabledProperty','HasKeyboardFocusProperty','IsPasswordProperty')){$cache.Add([Windows.Automation.AutomationElement]::$name)}
  foreach($pattern in @([Windows.Automation.InvokePattern]::Pattern,[Windows.Automation.ValuePattern]::Pattern,[Windows.Automation.TogglePattern]::Pattern,[Windows.Automation.SelectionItemPattern]::Pattern,[Windows.Automation.ExpandCollapsePattern]::Pattern,[Windows.Automation.ScrollPattern]::Pattern)){$cache.Add($pattern)}
  foreach($property in @([Windows.Automation.ValuePattern]::ValueProperty,[Windows.Automation.ValuePattern]::IsReadOnlyProperty,[Windows.Automation.TogglePattern]::ToggleStateProperty,[Windows.Automation.SelectionItemPattern]::IsSelectedProperty,[Windows.Automation.ExpandCollapsePattern]::ExpandCollapseStateProperty,[Windows.Automation.ScrollPattern]::HorizontalScrollPercentProperty,[Windows.Automation.ScrollPattern]::VerticalScrollPercentProperty)){$cache.Add($property)}
  $root=[Windows.Automation.AutomationElement]::FromHandle($hwnd); if ($null -eq $root) { throw 'UI Automation root unavailable' };$root=$root.GetUpdatedCache($cache)
  $walker=[Windows.Automation.TreeWalker]::ControlViewWalker; $items=New-Object System.Collections.Generic.List[object]; $lines=New-Object System.Collections.Generic.List[string]; $state=@{truncated=$false;textBytes=0}
  function Visit($element,[int[]]$locator,[int]$depth) {
    if ($items.Count -ge $maxNodes -or $depth -gt $maxDepth) { $state.truncated=$true; return }
    $role=Element-String $element 'ControlTypeProperty'; if ($role.StartsWith('ControlType.')) { $role=$role.Substring(12) }
    $name=Element-String $element 'NameProperty'; $aid=Element-String $element 'AutomationIdProperty'; $value=''
    $actions=New-Object System.Collections.Generic.List[string]
    $pattern=$null; if ($element.TryGetCachedPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) { $actions.Add('AXPress') }
    foreach($entry in @(@([Windows.Automation.TogglePattern]::Pattern,'AXToggle'),@([Windows.Automation.SelectionItemPattern]::Pattern,'AXSelect'),@([Windows.Automation.ExpandCollapsePattern]::Pattern,'AXExpand'))){$pattern=$null;if($element.TryGetCachedPattern($entry[0],[ref]$pattern)){$actions.Add($entry[1]);if($entry[1]-eq'AXExpand'){$actions.Add('AXCollapse')}}}
    $pattern=$null; if ($element.TryGetCachedPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$pattern)) { if(-not $pattern.Cached.IsReadOnly){$actions.Add('AXSetValue')}; if(-not $element.Cached.IsPassword){try { $value=[string]$pattern.Cached.Value } catch {}} }
    $selected=$null
    $pattern=$null;if($value.Length-eq0-and$element.TryGetCachedPattern([Windows.Automation.TogglePattern]::Pattern,[ref]$pattern)){$value=[string]$pattern.Cached.ToggleState}
    $pattern=$null;if($element.TryGetCachedPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)){$selected=[bool]$pattern.Cached.IsSelected}
    $pattern=$null;if($value.Length-eq0-and$element.TryGetCachedPattern([Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$pattern)){$value=[string]$pattern.Cached.ExpandCollapseState}
    $pattern=$null;if($value.Length-eq0-and$element.TryGetCachedPattern([Windows.Automation.ScrollPattern]::Pattern,[ref]$pattern)){$value='scroll(horizontal='+$pattern.Cached.HorizontalScrollPercent+',vertical='+$pattern.Cached.VerticalScrollPercent+')'}
    if($element.Cached.IsPassword){$value='[secure]'}
    $b=$element.Cached.BoundingRectangle; $frame=$null; if (-not $b.IsEmpty -and $b.Width -gt 0 -and $b.Height -gt 0) { $frame=[ordered]@{x=$b.X;y=$b.Y;width=$b.Width;height=$b.Height} }
    $item=[ordered]@{ index=$items.Count; locator=@($locator); role=$role; actions=$actions.ToArray(); enabled=[bool]$element.Cached.IsEnabled; focused=[bool]$element.Cached.HasKeyboardFocus }
    if($null-ne$selected){$item.selected=$selected}; if ($name) { $item.label=$name }; if ($aid) { $item.nativeIdentifier=$aid }; if ($value.Length -gt 0) { $item.value=$value.Substring(0,[Math]::Min(8192,$value.Length)) }; if ($null -ne $frame) { $item.frame=$frame }
    $items.Add($item); $line=('['+$item.index+'] '+$role+$(if($name){' '+$name}else{''})); if (($state.textBytes+[Text.Encoding]::UTF8.GetByteCount($line)+1) -le $maxTextBytes) { $state.textBytes+=[Text.Encoding]::UTF8.GetByteCount($line)+1; $lines.Add($line) } else { $state.truncated=$true }
    if ($depth -eq $maxDepth) { if($null-ne$walker.GetFirstChild($element,$cache)){$state.truncated=$true}; return }; $child=$walker.GetFirstChild($element,$cache); $i=0; while($null -ne $child) { Visit $child (@($locator)+$i) ($depth+1); if($items.Count -ge $maxNodes){if($null-ne$walker.GetNextSibling($child,$cache)){$state.truncated=$true};break}; $child=$walker.GetNextSibling($child,$cache); $i++ }
  }
  Visit $root @() 0
  return @{ root=$root; elements=$items.ToArray(); text=($lines -join "
"); truncated=[bool]$state.truncated }
}
function Get-StateHash($app,$window,$frontmost,$elements) { $canonical=([ordered]@{app=$app;window=$window;frontmost=[bool]$frontmost;elements=@($elements)}|ConvertTo-Json -Depth 40 -Compress); $sha=[Security.Cryptography.SHA256]::Create(); try { return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($canonical)))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() } }
function Capture-Bitmap([IntPtr]$hwnd,$frame) {
  if([EmateWin32]::IsIconic($hwnd)){throw 'minimized target window cannot be captured'}
  if(([int64]$frame.width*[int64]$frame.height)-gt33554432){throw 'target capture exceeds pixel bound'}
  $bmp=New-Object Drawing.Bitmap([int]$frame.width,[int]$frame.height)
  try {
    $g=[Drawing.Graphics]::FromImage($bmp)
    try { $g.Clear([Drawing.Color]::Black);$dc=$g.GetHdc();try{if(-not [EmateWin32]::PrintWindow($hwnd,$dc,2)){throw 'exact target window capture unavailable'}}finally{$g.ReleaseHdc($dc)} } finally { $g.Dispose() }
    return $bmp
  } catch { $bmp.Dispose(); throw }
}
function Capture-Window([IntPtr]$hwnd,$frame,[string]$path) {
  if ([IO.Path]::GetExtension($path).ToLowerInvariant() -ne '.png' -or -not [IO.Path]::IsPathRooted($path)) { throw 'screenshot path must be an absolute PNG allocated by the host' }
  $bmp=Capture-Bitmap $hwnd $frame
  try { $bmp.Save($path,[Drawing.Imaging.ImageFormat]::Png) } finally { $bmp.Dispose() }
  $info=[IO.FileInfo]$path; if (-not $info.Exists -or $info.Length -le 0 -or $info.Length -gt 268435456) { throw 'screenshot write failed or exceeded bound' }
  return [ordered]@{ path=$path; width=[int]$frame.width; height=[int]$frame.height }
}
function Observe($app,$options) {
  Assert-Interactive; $hwnd=[IntPtr][int64]$app.windowId; $actual=Assert-Target $app $hwnd; $frame=Get-Frame $hwnd
  $maxNodes=Assert-Int $options.maxNodes 10 5000 'maxNodes'; $maxDepth=Assert-Int $options.maxDepth 1 64 'maxDepth'; $maxText=Assert-Int $options.maxTextBytes 1024 1048576 'maxTextBytes'
  $tree=Get-Tree $hwnd $maxNodes $maxDepth $maxText; $window=[ordered]@{ title=(Element-String $tree.root 'NameProperty'); frame=$frame; id=$hwnd.ToInt64() }; $frontmost=([EmateWin32]::GetForegroundWindow() -eq $hwnd)
  $result=[ordered]@{ app=$actual; stateHash=(Get-StateHash $actual $window $frontmost $tree.elements); frontmost=$frontmost; window=$window; treeText=$tree.text; truncated=$tree.truncated; elements=$tree.elements; permissions=@{accessibility='granted';screenRecording='not-determined'} }
  if ([string]$options.screenshot -ne 'none') { try { $result.screenshot=Capture-Window $hwnd $frame ([string]$options.screenshotPath);$result.permissions.screenRecording='granted' } catch { $result.permissions.screenRecording='unavailable';if ([string]$options.screenshot -eq 'required') { throw } } }
  $null=Assert-Target $app $hwnd; $after=Get-Frame $hwnd; if($after.x-ne$frame.x-or$after.y-ne$frame.y-or$after.width-ne$frame.width-or$after.height-ne$frame.height){throw 'target window moved or resized during observation'}
  return $result
}
function Resolve-Element($root,$locator) { $walker=[Windows.Automation.TreeWalker]::ControlViewWalker; $current=$root; foreach($part in @($locator)) { $i=0; $child=$walker.GetFirstChild($current); while($i -lt [int]$part -and $null -ne $child) { $child=$walker.GetNextSibling($child); $i++ }; if($null -eq $child){throw 'UI Automation target locator is stale'}; $current=$child }; return $current }
function Ensure-Foreground([IntPtr]$hwnd,[string]$policy) { $before=[EmateWin32]::GetForegroundWindow(); if($before -eq $hwnd){return 'already-frontmost'}; if($policy -ne 'activate'){throw 'configured activation policy denies fallback while target is not foreground'}; if(-not [EmateWin32]::SetForegroundWindow($hwnd)){throw "SetForegroundWindow failed: $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"}; Start-Sleep -Milliseconds 30; if([EmateWin32]::GetForegroundWindow() -ne $hwnd){throw 'foreground HWND/PID verification failed immediately before input'}; return 'activated' }
function Assert-Control($app,[IntPtr]$root,[IntPtr]$control) {
  if(-not [EmateWin32]::IsWindow($control)-or($control-ne$root-and-not [EmateWin32]::IsChild($root,$control))){throw 'input HWND is outside exact target window'}
  [uint32]$owner=0;$null=[EmateWin32]::GetWindowThreadProcessId($control,[ref]$owner)
  if($owner-ne[uint32]$app.pid){throw 'input HWND/PID changed'}
}
function Send-Checked($app,[IntPtr]$root,[IntPtr]$control,[uint32]$msg,[int64]$w=0,[int64]$l=0) {
  Assert-Control $app $root $control
  if(-not [EmateWin32]::Send($control,$msg,$w,$l)){throw 'target-window message delivery failed'}
}
function Resolve-Control($app,[IntPtr]$root,$element,[bool]$keyboard) {
  $control=[IntPtr]::Zero
  if($null-ne$element){$control=[IntPtr]$element.Current.NativeWindowHandle}
  if($control-eq[IntPtr]::Zero-and$keyboard){[uint32]$owner=0;$thread=[EmateWin32]::GetWindowThreadProcessId($root,[ref]$owner);$info=New-Object EmateWin32+GUITHREADINFO;$info.cbSize=[Runtime.InteropServices.Marshal]::SizeOf($info);if(-not [EmateWin32]::GetGUIThreadInfo($thread,[ref]$info)){throw 'target keyboard control unavailable'};$control=$info.hwndFocus}
  Assert-Control $app $root $control
  $class=[EmateWin32]::ClassName($control)
  # Only documented native control messages; custom/WebView controls fail closed.
  $pattern=if($keyboard){'^(Edit|RichEdit[0-9]*[AW]?|RICHEDIT50W)$'}else{'^(Edit|RichEdit[0-9]*[AW]?|RICHEDIT50W|ListBox|SysListView32|SysTreeView32|ScrollBar)$'}
  if($class-notmatch$pattern){throw 'target control does not support reliable background messages'}
  return $control
}
function Screen-Point($frame,[double]$x,[double]$y,[string]$space) {
  if([double]::IsNaN($x)-or[double]::IsInfinity($x)-or[double]::IsNaN($y)-or[double]::IsInfinity($y)){throw 'invalid input point'}
  if($space-eq'window'){$x+=$frame.x;$y+=$frame.y}elseif($space-ne'screen'){throw 'unsupported coordinate space'}
  if($x-lt$frame.x-or$y-lt$frame.y-or$x-ge($frame.x+$frame.width)-or$y-ge($frame.y+$frame.height)){throw 'input point is outside the exact target window'}
  return @{x=[int]$x;y=[int]$y}
}
function Point-LParam([IntPtr]$hwnd,$point) {
  $p=New-Object EmateWin32+POINT;$p.X=$point.x;$p.Y=$point.y
  if(-not [EmateWin32]::ScreenToClient($hwnd,[ref]$p)){throw 'ScreenToClient failed'}
  if($p.X-lt-32768-or$p.X-gt32767-or$p.Y-lt-32768-or$p.Y-gt32767){throw 'client point exceeds signed message coordinates'}
  return [EmateWin32]::Pack($p.X,$p.Y)
}
function Point-Element($root,$current,$point) {
  if($current.truncated){throw 'truncated UIA tree cannot authorize coordinate hit testing'}
  $matches=@($current.elements|Where-Object{$b=$_.frame;$null-ne$b-and$point.x-ge$b.x-and$point.y-ge$b.y-and$point.x-lt($b.x+$b.width)-and$point.y-lt($b.y+$b.height)}|Sort-Object { @($_.locator).Count } -Descending)
  if($matches.Count-eq0){throw 'no exact UIA element at target point'}
  if($matches.Count-gt1-and@($matches[0].locator).Count-eq@($matches[1].locator).Count){throw 'ambiguous UIA elements at target point'}
  return Resolve-Element $root $matches[0].locator
}
function Invoke-Semantic($element,[string]$action) {
  if($null-eq$element-or-not$element.Current.IsEnabled){throw 'enabled UIA target unavailable'}
  $pattern=$null
  switch($action){
    'AXPress'{if(-not$element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)){throw 'UIA InvokePattern unavailable'};$pattern.Invoke()}
    'AXToggle'{if(-not$element.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern,[ref]$pattern)){throw 'UIA TogglePattern unavailable'};$pattern.Toggle()}
    'AXSelect'{if(-not$element.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)){throw 'UIA SelectionItemPattern unavailable'};$pattern.Select()}
    'AXExpand'{if(-not$element.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$pattern)){throw 'UIA ExpandCollapsePattern unavailable'};$pattern.Expand()}
    'AXCollapse'{if(-not$element.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern,[ref]$pattern)){throw 'UIA ExpandCollapsePattern unavailable'};$pattern.Collapse()}
    default{throw 'unsupported UIA semantic action'}
  }
}
function Click-Semantic($element) {
  foreach($entry in @(@([Windows.Automation.InvokePattern]::Pattern,'AXPress'),@([Windows.Automation.TogglePattern]::Pattern,'AXToggle'),@([Windows.Automation.SelectionItemPattern]::Pattern,'AXSelect'),@([Windows.Automation.ExpandCollapsePattern]::Pattern,'AXExpand'))){$pattern=$null;if($element.TryGetCurrentPattern($entry[0],[ref]$pattern)){Invoke-Semantic $element $entry[1];return $true}}
  return $false
}
function Resolve-Key([string]$name) { $keys=@{enter=0x0D;backspace=0x08;delete=0x2E;home=0x24;end=0x23;pageup=0x21;pagedown=0x22;arrowup=0x26;arrowdown=0x28;arrowleft=0x25;arrowright=0x27};$n=$name.ToLowerInvariant();if($keys.ContainsKey($n)){return $keys[$n]};throw 'unsupported targeted key; global shortcuts and clipboard input are unavailable' }
$script:heldInput=$null
function Release-Held {
  if($null-ne$script:heldInput){$held=$script:heldInput;Send-Checked $held.app $held.root $held.control $held.message $held.key $held.point;$script:heldInput=$null}
}
function Release-Input($app,$window,$action) {
  Assert-Interactive;$hwnd=[IntPtr][int64]$app.windowId;$actual=Assert-Target $app $hwnd
  if([int64]$window.id-ne$hwnd.ToInt64()){throw 'cleanup HWND does not match bound app'}
  if($null-ne$script:heldInput){if(-not(Same-App $app $script:heldInput.app)){throw 'cleanup target does not match held input'};Release-Held}
  return @{cleanupComplete=$true;target=$actual}
}
function Act($request) {
  Assert-Interactive;$app=$request.app;$hwnd=[IntPtr][int64]$app.windowId;$null=Assert-Target $app $hwnd
  if([int64]$request.window.id-ne$hwnd.ToInt64()){throw 'action HWND does not match bound app'}
  $current=Observe $app @{screenshot='none';maxNodes=(Assert-Int $request.limits.maxNodes 10 5000 'maxNodes');maxDepth=(Assert-Int $request.limits.maxDepth 1 64 'maxDepth');maxTextBytes=(Assert-Int $request.limits.maxTextBytes 1024 1048576 'maxTextBytes')}
  if($current.stateHash-cne[string]$request.expectedStateHash){throw 'stale UI Automation state hash'}
  $f=$current.window.frame;$expected=$request.window.frame
  if($f.x-ne$expected.x-or$f.y-ne$expected.y-or$f.width-ne$expected.width-or$f.height-ne$expected.height){throw 'target window moved or resized'}
  $a=$request.action;$activation='not-requested';$channel='accessibility';$pointer=$false;$routing='none'
  $uiaRoot=[Windows.Automation.AutomationElement]::FromHandle($hwnd);if($null-eq$uiaRoot){throw 'UI Automation root unavailable'}
  $element=$null;if($null-ne$request.element){$element=Resolve-Element $uiaRoot $request.element.locator}
  $before=[EmateWin32]::GetForegroundWindow()
  if($a.kind-eq'set-value'){
    if(([string]$a.value).Length-gt8192){throw 'text exceeds bound'};$p=$null
    if($null-eq$element-or-not$element.Current.IsEnabled-or-not$element.TryGetCurrentPattern([Windows.Automation.ValuePattern]::Pattern,[ref]$p)-or$p.Current.IsReadOnly){throw 'writable UIA ValuePattern unavailable'}
    $p.SetValue([string]$a.value)
  } elseif($a.kind-eq'perform-action'){
    if($a.action-eq'AXRaise'){if($request.interaction.focusPolicy-ne'activate'){throw 'preserve focus policy denies AXRaise'};$activation=Ensure-Foreground $hwnd 'activate'}
    else{Invoke-Semantic $element ([string]$a.action)}
  } elseif($a.kind-eq'type-text'){
    $text=[string]$a.text;if($text.Length-gt8192){throw 'text exceeds bound'}
    $control=Resolve-Control $app $hwnd $element $true;$channel='keyboard'
    # WM_CHAR targets the checked native edit's existing selection; no SetFocus or clipboard.
    foreach($ch in $text.ToCharArray()){Send-Checked $app $hwnd $control 0x0102 ([int]$ch) 0}
  } elseif($a.kind-eq'press-key'){
    $control=Resolve-Control $app $hwnd $element $true;$channel='keyboard';$mods=@($a.modifiers)
    if($mods.Count-eq1-and$mods[0]-eq'control'-and$a.key-eq'a'){Send-Checked $app $hwnd $control 0x00B1 0 -1}
    elseif($mods.Count-ne0){throw 'unsupported targeted modifiers; clipboard and global shortcuts are unavailable'}
    else{$vk=Resolve-Key ([string]$a.key);if($vk-eq0x08-or$vk-eq0x0D){Send-Checked $app $hwnd $control 0x0102 $vk 0}else{$script:heldInput=@{app=$app;root=$hwnd;control=$control;message=0x0101;key=$vk;point=0};try{Send-Checked $app $hwnd $control 0x0100 $vk 0}finally{Release-Held}}}
  } elseif($a.kind-eq'click'-or$a.kind-eq'scroll'-or$a.kind-eq'drag'){
    if($request.interaction.pointerInputPolicy-ne'targeted'){throw 'targeted pointer policy is required'}
    $space=if($a.coordinateSpace){[string]$a.coordinateSpace}else{'window'}
    if($a.kind-eq'drag'){$point=Screen-Point $f $a.fromX $a.fromY $space;$end=Screen-Point $f $a.toX $a.toY $space}
    elseif($null-ne$element){$b=$element.Current.BoundingRectangle;$point=Screen-Point $f ($b.X+$b.Width/2) ($b.Y+$b.Height/2) 'screen'}
    else{$point=Screen-Point $f $a.x $a.y $space}
    if($null-eq$element){$element=Point-Element $uiaRoot $current $point}
    $count=Assert-Int $(if($a.clickCount){$a.clickCount}else{1}) 1 3 'clickCount'
    if($a.kind-eq'click'-and(-not$a.button-or$a.button-eq'left')-and$count-eq1-and(Click-Semantic $element)){}
    elseif($a.kind-eq'scroll'){
      $pages=Assert-Int $(if($a.pages){$a.pages}else{1}) 1 10 'pages';$direction=[string]$a.direction
      if($direction-notin@('up','down','left','right')){throw 'unsupported scroll direction'}
      $horizontal=$direction-eq'left'-or$direction-eq'right';$amount=if($direction-eq'up'-or$direction-eq'left'){[Windows.Automation.ScrollAmount]::LargeDecrement}else{[Windows.Automation.ScrollAmount]::LargeIncrement}
      $p=$null;$scrollElement=$element;$walker=[Windows.Automation.TreeWalker]::ControlViewWalker
      while($null-ne$scrollElement){if($scrollElement.TryGetCurrentPattern([Windows.Automation.ScrollPattern]::Pattern,[ref]$p)){break};if($scrollElement.Equals($uiaRoot)){break};$scrollElement=$walker.GetParent($scrollElement)}
      if($null-ne$p){for($i=0;$i-lt$pages;$i++){if($horizontal){$p.Scroll($amount,[Windows.Automation.ScrollAmount]::NoAmount)}else{$p.Scroll([Windows.Automation.ScrollAmount]::NoAmount,$amount)}}}
      else{$control=Resolve-Control $app $hwnd $element $false;$msg=if($horizontal){0x0114}else{0x0115};$command=if($direction-eq'up'-or$direction-eq'left'){2}else{3};for($i=0;$i-lt$pages;$i++){Send-Checked $app $hwnd $control $msg $command 0};$channel='coordinates';$pointer=$true;$routing='target-process'}
    } else {
      # Raw native pointer handlers may focus controls: preserve allows them only
      # when the exact target is already frontmost. Never activate as a fallback.
      if($a.kind-eq'click'-and$null-ne$request.element-and$a.allowCoordinateFallback-ne$true-and($null-eq$a.x-or$null-eq$a.y)){throw 'coordinate fallback was not explicitly selected'}
      if($before-ne$hwnd){throw 'background raw pointer input is unavailable for this target'}
      $control=Resolve-Control $app $hwnd $element $false;$lp=Point-LParam $control $point
      $channel='coordinates';$pointer=$true;$routing='target-process';$activation='already-frontmost'
      $down=0x0201;$up=0x0202;$wp=1;if($a.button-eq'right'){$down=0x0204;$up=0x0205;$wp=2}elseif($a.button-eq'middle'){$down=0x0207;$up=0x0208;$wp=0x10}
      $to=if($a.kind-eq'drag'){Point-LParam $control $end}else{$lp}
      $script:heldInput=@{app=$app;root=$hwnd;control=$control;message=$up;key=0;point=$to}
      try {for($i=0;$i-lt$count;$i++){if([EmateWin32]::GetForegroundWindow()-ne$hwnd){throw 'foreground changed before raw input'};$press=if($i-eq1){$down+2}else{$down};Send-Checked $app $hwnd $control $press $wp $lp;if($a.kind-eq'drag'){Send-Checked $app $hwnd $control 0x0200 $wp $to};Send-Checked $app $hwnd $control $up 0 $to}} finally {Release-Held}
    }
  } else {throw 'unsupported action'}
  $null=Assert-Target $app $hwnd
  if($request.interaction.focusPolicy-eq'preserve'-and[EmateWin32]::GetForegroundWindow()-ne$before){throw 'foreground changed during action; result is unverified'}
  return @{channel=$channel;activation=$activation;pointerInput=$pointer;pointerRouting=$routing;cleanupComplete=$true;targetVerified=$true;target=@{bundleId=$app.bundleId;pid=$app.pid;name=$app.name;executablePath=$app.executablePath;windowId=$request.window.id;processStartTime=$app.processStartTime;preStateHash=$request.expectedStateHash}}
}

# Compile and load UIA once per private subprocess generation. No server or external transport.
$script:requestId=$null
while($null-ne($raw=[EmateWin32]::ReadRequest([Console]::In))) {
  try {
    if([Text.Encoding]::UTF8.GetByteCount($raw)-gt262144){throw 'request exceeds protocol limit'}
    $request=$raw|ConvertFrom-Json
    if($request.protocolVersion-ne2-or([string]$request.requestId)-notmatch'^[a-f0-9-]{36}:[1-9][0-9]{0,15}$'){throw 'unsupported protocol identity'}
    $script:requestId=[string]$request.requestId
    if($request.command-eq'hello'){Reply-Ok @{helperVersion='1.0.0';protocolVersion=2};continue}
    Assert-Interactive
    switch([string]$request.command){
      'health'{Reply-Ok (Get-Health)}
      'list-apps'{ $rows=@();foreach($h in Get-Windows){try{$a=Get-App $h;$rows+=,@{bundleId=$a.bundleId;pid=$a.pid;name=$a.name;executablePath=$a.executablePath;processStartTime=$a.processStartTime;windowId=$a.windowId;frontmost=([EmateWin32]::GetForegroundWindow()-eq$h);accessibility='granted';screenRecording='not-determined'};if($rows.Count-ge256){break}}catch{}};Reply-Ok $rows }
      'resolve-app'{Reply-Ok (Resolve-App $request.selector)}
      'observe'{Reply-Ok (Observe $request.app $request.options)}
      'act'{Reply-Ok (Act $request.request)}
      'release-input'{Reply-Ok (Release-Input $request.app $request.window $request.action)}
      default{throw 'unknown command'}
    }
  } catch { $message=$_.Exception.Message;$code=if($message-match'stale|changed|replaced|moved|resized'){'COMPUTER_STALE_OBSERVATION'}elseif($message-match'locked|secure desktop|RDP|elevated|UIPI|authority|foreground|policy|unsupported|unavailable|denied'){'COMPUTER_ACTION_BLOCKED'}else{'COMPUTER_PROVIDER_FAILURE'};Reply-Fail $code $message }
  finally { $script:requestId=$null }
}
