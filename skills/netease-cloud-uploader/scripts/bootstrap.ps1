$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot

Push-Location $projectRoot
try {
    npm install
    npm run check
    [pscustomobject]@{
        ok = $true
        data = [pscustomobject]@{
            projectRoot = $projectRoot
            installed = $true
        }
    } | ConvertTo-Json -Compress
}
finally {
    Pop-Location
}
