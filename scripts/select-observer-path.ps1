param([Parameter(Mandatory=$true)][ValidateSet('file','directory')][string]$Kind)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()
$pickerOwner = New-Object System.Windows.Forms.Form
$pickerOwner.Text = 'NexusAPI local path selection'
$pickerOwner.TopMost = $true
$pickerOwner.ShowInTaskbar = $false
$pickerOwner.Width = 1
$pickerOwner.Height = 1
$pickerOwner.Opacity = 0
$pickerOwner.Show()
$selectedPath = $null
$pickerDialog = $null
try {
  if ($Kind -eq 'file') {
    $pickerDialog = New-Object System.Windows.Forms.OpenFileDialog
    $pickerDialog.Title = 'NexusAPI - Select Codex JSONL file'
    $pickerDialog.Filter = 'Codex rollout (*.jsonl)|*.jsonl'
    $pickerDialog.Multiselect = $false
    $pickerDialog.CheckFileExists = $true
    $pickerDialog.CheckPathExists = $true
    $pickerDialog.RestoreDirectory = $true
  } else {
    $pickerDialog = New-Object System.Windows.Forms.FolderBrowserDialog
    $pickerDialog.Description = 'NexusAPI - Select Codex records folder'
    $pickerDialog.ShowNewFolderButton = $false
    $pickerDialog.RootFolder = [System.Environment+SpecialFolder]::MyComputer
  }
  if ($pickerDialog.ShowDialog($pickerOwner) -eq [System.Windows.Forms.DialogResult]::OK) {
    if ($Kind -eq 'file') { $selectedPath = $pickerDialog.FileName }
    else { $selectedPath = $pickerDialog.SelectedPath }
  }
  @{ path = $selectedPath } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $pickerDialog) { $pickerDialog.Dispose() }
  $pickerOwner.Close()
  $pickerOwner.Dispose()
}
