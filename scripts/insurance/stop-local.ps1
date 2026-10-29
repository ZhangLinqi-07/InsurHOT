$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$statePath = Join-Path $projectRoot '.data\local-services.json'
$collectorPath = Join-Path $projectRoot '.data\insurance-ingestion'
$collectorState = Join-Path $collectorPath 'service.json'
if (Test-Path -LiteralPath $collectorState) {
  $collector = Get-Content -Raw -LiteralPath $collectorState | ConvertFrom-Json
  $collectorProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($collector.pid)" -ErrorAction SilentlyContinue
  if ($collectorProcess -and $collectorProcess.CommandLine -like '*collector-daemon.ts*' -and $collectorProcess.CommandLine -like "*$projectRoot*") {
    Set-Content -LiteralPath (Join-Path $collectorPath 'stop') -Value 'stop' -Encoding utf8
    try { Wait-Process -Id $collector.pid -Timeout 45 -ErrorAction Stop }
    catch { throw 'The collector is finishing a request. Run stop-local.ps1 again after its current page finishes.' }
  }
}
if (!(Test-Path -LiteralPath $statePath)) { Write-Output 'No local InsurHOT service record.'; exit }
$state = Get-Content -Raw -LiteralPath $statePath | ConvertFrom-Json
if ($state.services | Where-Object name -eq 'worker') { throw 'A worker is recorded. Stop it gracefully before stopping the page processes.' }
foreach ($service in $state.services) {
  $process = Get-CimInstance Win32_Process -Filter "ProcessId = $($service.pid)" -ErrorAction SilentlyContinue
  if ($process -and $process.CommandLine -like "*$projectRoot*") { Stop-Process -Id $service.pid }
}
Remove-Item -LiteralPath $statePath
Write-Output 'Local InsurHOT page processes stopped.'
