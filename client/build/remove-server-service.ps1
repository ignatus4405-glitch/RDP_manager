# Invoked only when a previously installed server component is deselected.
# Never stop or remove a service registered to a different executable.
$ErrorActionPreference = 'Stop'
$name = 'RDPManagerServer'
$expected = [IO.Path]::GetFullPath((Join-Path $env:RDP_INSTALL_DIR 'server\RDPManagerServer.exe'))
$service = Get-CimInstance Win32_Service -Filter "Name='$name'"
if (-not $service) { exit 0 }
$actual = [Environment]::ExpandEnvironmentVariables($service.PathName.Trim().Trim('"'))
if (-not [string]::Equals($actual, $expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'A different service already uses the RDPManagerServer name; refusing to remove it.' }
$controller = [System.ServiceProcess.ServiceController]::new($name)
try {
  $controller.Refresh()
  if ($controller.Status -eq [System.ServiceProcess.ServiceControllerStatus]::StartPending) { $controller.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Running, [TimeSpan]::FromSeconds(45)); $controller.Refresh() }
  if ($controller.Status -ne [System.ServiceProcess.ServiceControllerStatus]::Stopped -and $controller.Status -ne [System.ServiceProcess.ServiceControllerStatus]::StopPending) { $controller.Stop() }
  $controller.WaitForStatus([System.ServiceProcess.ServiceControllerStatus]::Stopped, [TimeSpan]::FromSeconds(45))
} finally { $controller.Dispose() }
& "$env:SystemRoot\System32\sc.exe" delete $name
if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne 1060 -and $LASTEXITCODE -ne 1072) { throw "Could not remove service; sc.exe exit code $LASTEXITCODE." }
