# Preserve a verified existing registration; do not silently take over an
# unrelated service. An old registration may still be pending deletion.
$ErrorActionPreference = 'Stop'
$name = 'RDPManagerServer'
$expected = [IO.Path]::GetFullPath((Join-Path $env:RDP_INSTALL_DIR 'server\RDPManagerServer.exe'))
for ($attempt = 0; $attempt -lt 30; $attempt++) {
  $key = Get-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Services\$name" -ErrorAction SilentlyContinue
  if ($key -and $key.DeleteFlag -eq 1) { Start-Sleep -Seconds 1; continue }
  $service = Get-CimInstance Win32_Service -Filter "Name='$name'"
  if ($service) {
    $actual = [Environment]::ExpandEnvironmentVariables($service.PathName.Trim().Trim('"'))
    if (-not [string]::Equals($actual, $expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'A different service already uses the RDPManagerServer name; refusing to modify it.' }
    exit 0
  }
  & $expected install
  $code = $LASTEXITCODE
  if ($code -eq 0) { exit 0 }
  # 1072 = marked for deletion, 1073 = another process created it; recheck.
  if ($code -ne 1072 -and $code -ne 1073) { exit $code }
  Start-Sleep -Seconds 1
}
throw 'Service registration is pending deletion or could not be confirmed. Close the Services console and retry.'
