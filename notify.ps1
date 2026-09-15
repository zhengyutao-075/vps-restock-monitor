param(
  [Parameter(Mandatory = $true)][string]$Title,
  [Parameter(Mandatory = $true)][string]$Message,
  [string]$Url = '',
  [string]$LogFile = ''
)

# Windows desktop toast notification. No third-party module required.
#
# ASCII-only source on purpose: Windows PowerShell 5.1 reads a .ps1 file that has
# no BOM using the ANSI code page, so non-ASCII source text corrupts parsing.
# Non-ASCII notification text is still safe because it arrives as a command-line
# argument (UTF-16), never as source bytes.

$ErrorActionPreference = 'Stop'

function Esc([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return '' }
  return $s.Replace('&', '&amp;').Replace('<', '&lt;').Replace('>', '&gt;').Replace('"', '&quot;').Replace("'", '&apos;')
}

function Write-Log([string]$line) {
  if ([string]::IsNullOrEmpty($LogFile)) { return }
  try {
    $stamp = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    Add-Content -LiteralPath $LogFile -Value ('[' + $stamp + '] ' + $line) -Encoding UTF8
  } catch { }
}

$titleXml = Esc $Title
$msgXml = Esc $Message
$msgXml = $msgXml.Replace("`r`n", '&#10;').Replace("`n", '&#10;')
$launch = ''
if ($Url) { $launch = Esc $Url }

$xml = '<toast activationType="protocol" launch="' + $launch + '">' +
       '<visual><binding template="ToastGeneric">' +
       '<text>' + $titleXml + '</text>' +
       '<text>' + $msgXml + '</text>' +
       '</binding></visual>' +
       '<audio src="ms-winsoundevent:Notification.Default" />' +
       '</toast>'

$ok = $false
try {
  [void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
  [void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
  $doc = New-Object Windows.Data.Xml.Dom.XmlDocument
  $doc.LoadXml($xml)
  $toast = New-Object Windows.UI.Notifications.ToastNotification $doc
  $aumid = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe'
  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid).Show($toast)
  $ok = $true
  Write-Output 'toast-shown'
  Write-Log ('toast-shown | ' + $Title)
}
catch {
  Write-Log ('toast-failed: ' + $_.Exception.Message)
}

if (-not $ok) {
  try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $ni = New-Object System.Windows.Forms.NotifyIcon
    $ni.Icon = [System.Drawing.SystemIcons]::Information
    $ni.Visible = $true
    $ni.ShowBalloonTip(10000, $Title, $Message, [System.Windows.Forms.ToolTipIcon]::Info)
    Start-Sleep -Milliseconds 4000
    $ni.Dispose()
    Write-Output 'balloon-shown'
    Write-Log ('balloon-shown | ' + $Title)
  }
  catch {
    Write-Output ('notify-failed: ' + $_.Exception.Message)
    Write-Log ('balloon-failed: ' + $_.Exception.Message)
  }
}
