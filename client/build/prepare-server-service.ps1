# Run by the elevated installer before overwriting server files. Never adopt a
# service registered to a different executable. This also handles upgrades from
# older uninstallers that did not remove the service successfully.
$ErrorActionPreference = 'Stop'
$serviceName = 'RDPManagerServer'
$expected = [IO.Path]::GetFullPath((Join-Path $env:RDP_INSTALL_DIR 'server\RDPManagerServer.exe'))
$service = Get-CimInstance Win32_Service -Filter "Name='$serviceName'"
if (-not $service) { exit 0 }
$actual = [Environment]::ExpandEnvironmentVariables($service.PathName.Trim().Trim('"'))
if (-not [string]::Equals($actual, $expected, [StringComparison]::OrdinalIgnoreCase)) {
  Write-Error 'A different service already uses the RDPManagerServer name; refusing to modify it.'
  exit 1
}
$controller = [System.ServiceProcess.ServiceController]::new($serviceName)
try {
  $controller.Refresh()
  if ($controller.Status -eq [System.ServiceProcess.ServiceControllerStatus]::StartPending) {
    $controller.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(45))
    $controller.Refresh()
  }
  if ($controller.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped -and $controller.Status -ne [System.ServiceProcess.ServiceControllerStatus]::StopPending) { $controller.Stop() }
  $controller.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(45))
} finally { $controller.Dispose() }
