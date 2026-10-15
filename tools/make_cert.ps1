<#
.SYNOPSIS
    Creates the code-signing identity InfantGod Studio is signed with.

.DESCRIPTION
    Produces a self-signed certificate with the Code Signing EKU, exports the
    private key to a password-protected .pfx and the public half to a .cer, and
    stores both outside the repository under %USERPROFILE%\.infantgod.

    The private key never enters the checkout: a key in version control is a key
    you have to rotate.  tools/sign.mjs finds it there by convention.

    A self-signed certificate proves the artifact has not changed since it was
    signed.  It does not prove *who* signed it, because no authority vouches for
    the name -- so Windows still treats it as unknown on any machine that has not
    been told to trust it.  This script trusts it on the machine it runs on.
    Replacing it with a real certificate is a matter of exporting that one to the
    same .pfx path, or of setting CSC_LINK / CSC_KEY_PASSWORD yourself.

    Kept ASCII-only on purpose: Windows PowerShell 5.1 reads a BOM-less script as
    ANSI, and non-ASCII text in here becomes a parse error on machines whose
    ANSI codepage is not UTF-8.

.PARAMETER Subject
    Certificate subject.  Default CN=InfantGod Studio.

.PARAMETER Years
    Validity.  Default 3.

.PARAMETER Force
    Replace an existing identity.

.PARAMETER NoTrust
    Skip installing the public half into the current user's Trusted Root, which
    is what makes the signature validate on this machine.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File tools/make_cert.ps1
#>
[CmdletBinding()]
param(
    [string] $Subject = 'CN=InfantGod Studio',
    [int]    $Years = 3,
    [switch] $Force,
    [switch] $NoTrust
)

$ErrorActionPreference = 'Stop'

$dir    = Join-Path $env:USERPROFILE '.infantgod'
$pfx    = Join-Path $dir 'codesign.pfx'
$pwFile = Join-Path $dir 'codesign.pw'
$cer    = Join-Path $dir 'codesign.cer'

if ((Test-Path $pfx) -and -not $Force) {
    Write-Host "a signing identity already exists: $pfx"
    Write-Host "pass -Force to replace it (artifacts signed with the old one stay valid,"
    Write-Host "but nothing will verify against the new one)."
    exit 0
}

New-Item -ItemType Directory -Force -Path $dir | Out-Null

# 32 bytes of CSPRNG, base64'd: long enough that the password is not the weak
# link, short enough to keep the file readable.  Create()+GetBytes is the form
# that exists in both Windows PowerShell 5.1 and PowerShell 7.
$bytes = New-Object byte[] 32
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$password = [Convert]::ToBase64String($bytes)

Write-Host 'generating a self-signed code-signing certificate ...'
$cert = New-SelfSignedCertificate `
    -Type CodeSigningCert `
    -Subject $Subject `
    -FriendlyName 'InfantGod Studio (self-signed)' `
    -CertStoreLocation 'Cert:\CurrentUser\My' `
    -KeyAlgorithm RSA `
    -KeyLength 3072 `
    -HashAlgorithm SHA256 `
    -KeyExportPolicy Exportable `
    -NotAfter (Get-Date).AddYears($Years)

$secure = ConvertTo-SecureString -String $password -AsPlainText -Force
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $secure | Out-Null
Export-Certificate -Cert $cert -FilePath $cer | Out-Null
Set-Content -Path $pwFile -Value $password -NoNewline -Encoding ascii

# Restrict the private key to this account.  Inheritance is dropped on purpose:
# inheriting "Users: read" from %USERPROFILE% would defeat the point.
$grant = '{0}:(R,W)' -f "$env:USERDOMAIN\$env:USERNAME"
& icacls.exe $pfx    /inheritance:r /grant:r $grant | Out-Null
& icacls.exe $pwFile /inheritance:r /grant:r $grant | Out-Null

$trusted = $false
if (-not $NoTrust) {
    # certutil, not Import-Certificate: writing to the Root store is a
    # security-relevant change, so the cmdlet raises a consent dialog, and a
    # dialog needs a desktop.  certutil's -user form does it headlessly for the
    # current account only, which is exactly the scope we want.
    & certutil.exe -user -addstore Root $cer > $null 2>&1
    $trusted = ($LASTEXITCODE -eq 0)
    if (-not $trusted) {
        Write-Warning 'could not install the certificate into the current user''s Trusted Root; the signature will be untrusted on this machine too.'
    }
}

$trustNote = if ($NoTrust) { 'no (-NoTrust)' } elseif ($trusted) { "yes (Cert:\CurrentUser\Root)" } else { 'no' }

Write-Host ''
Write-Host "  subject   $($cert.Subject)"
Write-Host "  thumb     $($cert.Thumbprint)"
Write-Host "  expires   $($cert.NotAfter.ToString('yyyy-MM-dd'))"
Write-Host "  key       $pfx"
Write-Host "  password  $pwFile"
Write-Host "  public    $cer"
Write-Host "  trusted   $trustNote"
Write-Host ''
Write-Host '`npm run dist` will pick it up from here.'
