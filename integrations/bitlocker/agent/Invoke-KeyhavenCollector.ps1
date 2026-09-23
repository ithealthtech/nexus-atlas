#requires -Version 7.4
#requires -RunAsAdministrator
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$ConfigPath,
    [string]$QueueDirectory="$env:ProgramData\Keyhaven\Queue",
    [switch]$Upload
)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$VerbosePreference='SilentlyContinue'
$DebugPreference='SilentlyContinue'
try {
    if (-not $IsWindows -or -not [Environment]::Is64BitProcess) { throw 'Requires 64-bit Windows PowerShell 7.4 or later' }
    . "$PSScriptRoot\Keyhaven.Core.ps1"
    $config=Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    if ($config.version -ne 1 -or -not [guid]::TryParse([string]$config.agentId,[ref]([guid]::Empty))) { throw 'Invalid enrollment configuration' }
    # Validate the public key before reading the machine's recovery material.
    $null=[Keyhaven.AgentCrypto]::Encrypt([string]$config.publicKey,'configuration-check')
    if ($Upload) { $null=Assert-KeyhavenEndpoint ([string]$config.endpoint) }
    $root=[IO.Path]::GetFullPath($QueueDirectory)
    if ($root.StartsWith('\\') -or -not [IO.Path]::IsPathFullyQualified($root)) { throw 'Queue must be on a local drive' }
    $root=$root.TrimEnd('\')+'\'+([guid]$config.agentId).ToString()
    $directory=New-Item -ItemType Directory -Path $root -Force
    # Reject junction/symlink redirection anywhere in the queue ancestry.
    $ancestor=$directory
    while ($null -ne $ancestor) {
        if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Queue path cannot contain reparse points' }
        $ancestor=$ancestor.Parent
    }
    $acl=[Security.AccessControl.DirectorySecurity]::new()
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($sid in @('S-1-5-18','S-1-5-32-544')) {
        $identity=[Security.Principal.SecurityIdentifier]::new($sid)
        $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
        $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $root -AclObject $acl
    # One run per enrollment, including under concurrent RMM invocations.
    $lock=[IO.File]::Open((Join-Path $root 'collector.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
    try {
        $pending=@(Get-ChildItem -LiteralPath $root -Filter '*.json' -File)
        if ($pending.Count -ge 100) { throw 'Encrypted queue is full; collect or upload pending reports before retrying' }
        $report=Get-KeyhavenReport -Config $config
        $json=ConvertTo-Json -InputObject $report -Depth 10 -Compress
        if ([Text.Encoding]::UTF8.GetByteCount($json) -gt 100000) { throw 'Report exceeds the supported size' }
        $path=Join-Path $root ($report.reportId+'.json')
        $tempPath=$path+'.tmp'
        [IO.File]::WriteAllText($tempPath,$json,[Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $tempPath -Destination $path
        $keyCount=0
        foreach ($volume in $report.volumes) { $keyCount+=$volume.protectors.Count }
        if ($Upload) {
            # Oldest reports first preserves rotation history after an outage.
            foreach ($file in @(Get-ChildItem -LiteralPath $root -Filter '*.json' -File | Sort-Object CreationTimeUtc | Select-Object -First 50)) {
                if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Unexpected queue file type' }
                $queued=Get-Content -LiteralPath $file.FullName -Raw
                $parsed=$queued | ConvertFrom-Json
                if ($parsed.agentId -ne $config.agentId) { throw 'Queue enrollment mismatch' }
                Send-KeyhavenReport -Json $queued -Config $config
                Remove-Item -LiteralPath $file.FullName
            }
        }
        $mode=if ($Upload) {'uploaded'} else {'queued'}
        # RMM output deliberately excludes keys, credentials, identities, and provider exceptions.
        Write-Output ("Keyhaven: report {0}; volumes={1}; recoveryProtectors={2}" -f $mode,$report.volumes.Count,$keyCount)
    } finally { $lock.Dispose() }
    exit 0
} catch {
    Write-Output 'Keyhaven: collection or upload failed. Encrypted pending reports are retained. Check configuration, permissions, queue capacity, and connectivity.'
    exit 10
}
