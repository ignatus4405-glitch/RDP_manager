$ErrorActionPreference = 'Stop'
try {
    $xml = New-Object System.Xml.XmlDocument
    $xml.Load($env:RDP_INSTALL_XML)
    $entry = $xml.SelectSingleNode('/service/env[@name="RDP_MANAGER_DATA"]')
    if (-not $entry) { throw 'RDP_MANAGER_DATA is missing from the service configuration' }
    $entry.SetAttribute('value', $env:RDP_INSTALL_DATA)
    $xml.Save($env:RDP_INSTALL_XML)
} catch {
    Write-Error $_
    exit 1
}
