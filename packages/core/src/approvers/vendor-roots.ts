/**
 * Vendor attestation roots for the first trust-file key (#6945).
 *
 * A `packed` registration roots `.deft/approvers.json` only when its x5c chain
 * ends at one of these certificates. They are compared by SHA-256 fingerprint
 * and used as signature anchors; the OS trust store is never read, and
 * validity dates and revocation are not checked (no network read in verify).
 *
 * Each entry was copied byte for byte from the vendor's official published
 * file and cross-checked against the vendor's signed CA bundle:
 *   Yubico bundle: https://developers.yubico.com/PKI/yubico-ca-certs.txt
 *   (listing: https://developers.yubico.com/WebAuthn/Concepts/Securing_WebAuthn_with_Attestation.html)
 *
 * Sources and SHA-256 fingerprints (DER):
 *   - Yubico U2F Root CA Serial 457200631
 *     https://developers.yubico.com/PKI/yubico-fido-ca-1.pem
 *     0F:A1:38:6F:80:EB:87:13:26:3A:E5:C1:D8:4D:EB:45:5B:DF:08:AE:A5:0A:B0:55:03:CE:FE:E8:2B:09:2D:42
 *   - Yubico FIDO Root CA Serial 450203556
 *     https://developers.yubico.com/PKI/yubico-fido-ca-2.pem
 *     35:F1:A5:4B:35:3B:FB:71:1E:6D:42:AD:BE:B7:6C:0E:9D:EA:D0:95:01:8E:6A:94:78:3B:A2:19:2F:D6:FA:AD
 *   - Yubico Attestation Root 1
 *     https://developers.yubico.com/PKI/yubico-ca-1.pem
 *     62:76:0C:6A:6E:F9:16:79:F4:54:C8:90:2B:80:FD:00:98:25:B3:F2:5D:A9:0F:1F:BA:CE:2E:C6:58:6C:D5:A8
 *
 * Intermediates are not vendored: the registration's x5c must carry them.
 * Other vendors are added by appending an entry with its official source URL
 * and fingerprint; never a self-signed or locally made root.
 */

export interface VendorRoot {
  readonly vendor: string;
  readonly name: string;
  readonly sourceUrl: string;
  /** SHA-256 fingerprint of the DER certificate, colon-separated uppercase hex. */
  readonly sha256: string;
  readonly pem: string;
}

export const VENDOR_ROOTS: readonly VendorRoot[] = [
  {
    vendor: "Yubico",
    name: "Yubico U2F Root CA Serial 457200631",
    sourceUrl: "https://developers.yubico.com/PKI/yubico-fido-ca-1.pem",
    sha256:
      "0F:A1:38:6F:80:EB:87:13:26:3A:E5:C1:D8:4D:EB:45:5B:DF:08:AE:A5:0A:B0:55:03:CE:FE:E8:2B:09:2D:42",
    pem: `-----BEGIN CERTIFICATE-----
MIIDHjCCAgagAwIBAgIEG0BT9zANBgkqhkiG9w0BAQsFADAuMSwwKgYDVQQDEyNZ
dWJpY28gVTJGIFJvb3QgQ0EgU2VyaWFsIDQ1NzIwMDYzMTAgFw0xNDA4MDEwMDAw
MDBaGA8yMDUwMDkwNDAwMDAwMFowLjEsMCoGA1UEAxMjWXViaWNvIFUyRiBSb290
IENBIFNlcmlhbCA0NTcyMDA2MzEwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQC/jwYuhBVlqaiYWEMsrWFisgJ+PtM91eSrpI4TK7U53mwCIawSDHy8vUmk
5N2KAj9abvT9NP5SMS1hQi3usxoYGonXQgfO6ZXyUA9a+KAkqdFnBnlyugSeCOep
8EdZFfsaRFtMjkwz5Gcz2Py4vIYvCdMHPtwaz0bVuzneueIEz6TnQjE63Rdt2zbw
nebwTG5ZybeWSwbzy+BJ34ZHcUhPAY89yJQXuE0IzMZFcEBbPNRbWECRKgjq//qT
9nmDOFVlSRCt2wiqPSzluwn+v+suQEBsUjTGMEd25tKXXTkNW21wIWbxeSyUoTXw
LvGS6xlwQSgNpk2qXYwf8iXg7VWZAgMBAAGjQjBAMB0GA1UdDgQWBBQgIvz0bNGJ
hjgpToksyKpP9xv9oDAPBgNVHRMECDAGAQH/AgEAMA4GA1UdDwEB/wQEAwIBBjAN
BgkqhkiG9w0BAQsFAAOCAQEAjvjuOMDSa+JXFCLyBKsycXtBVZsJ4Ue3LbaEsPY4
MYN/hIQ5ZM5p7EjfcnMG4CtYkNsfNHc0AhBLdq45rnT87q/6O3vUEtNMafbhU6kt
hX7Y+9XFN9NpmYxr+ekVY5xOxi8h9JDIgoMP4VB1uS0aunL1IGqrNooL9mmFnL2k
LVVee6/VR6C5+KSTCMCWppMuJIZII2v9o4dkoZ8Y7QRjQlLfYzd3qGtKbw7xaF1U
sG/5xUb/Btwb2X2g4InpiB/yt/3CpQXpiWX/K4mBvUKiGn05ZsqeY1gx4g0xLBqc
U9psmyPzK+Vsgw2jeRQ5JlKDyqE0hebfC1tvFu0CCrJFcw==
-----END CERTIFICATE-----`,
  },
  {
    vendor: "Yubico",
    name: "Yubico FIDO Root CA Serial 450203556",
    sourceUrl: "https://developers.yubico.com/PKI/yubico-fido-ca-2.pem",
    sha256:
      "35:F1:A5:4B:35:3B:FB:71:1E:6D:42:AD:BE:B7:6C:0E:9D:EA:D0:95:01:8E:6A:94:78:3B:A2:19:2F:D6:FA:AD",
    pem: `-----BEGIN CERTIFICATE-----
MIIDMzCCAhugAwIBAgIUSOEjTf//yqRfPW7Qq8qtIyCrAg8wDQYJKoZIhvcNAQEL
BQAwLzEtMCsGA1UEAwwkWXViaWNvIEZJRE8gUm9vdCBDQSBTZXJpYWwgNDUwMjAz
NTU2MCAXDTI0MDUwMTAwMDAwMFoYDzIwNjAwNDMwMDAwMDAwWjAvMS0wKwYDVQQD
DCRZdWJpY28gRklETyBSb290IENBIFNlcmlhbCA0NTAyMDM1NTYwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQCdvl27w2gu1fPXeEFbIdqx0BalvVDVWrQP
J7HqviuEtZHlxSLxSFtcXpTolvLvof8f4tMerQTkVGzcmYzm1EBT4IJuMmoEqfkE
EhWpsADMFrjZkqlZY9EqxQzLoVEEonE5oGxSdVCxCcLIackpyR/CCXvj1Bt/hTgE
9hTlF4pRqxMkx3plF7y8dDZlRHWs7vbnhmBCGeI0ZPEQ6nl2mCg2r74adF2u6K9r
rLfhBC3QLE8EPrgqUsI+hkuq2tK4M2SMOp8uUVVkqUeu3h0kr3WVI0W02pkgrOgi
FKLFNkSrbYhdjMBDj5izmqfc9xJRKoDX612qd8ZGVHpT5AYFX+1hAgMBAAGjRTBD
MB0GA1UdDgQWBBTZyU5DiQ/a2UEgE7qBK0zhIsRNRjASBgNVHRMBAf8ECDAGAQH/
AgEAMA4GA1UdDwEB/wQEAwIBBjANBgkqhkiG9w0BAQsFAAOCAQEAXvnB4SLuUJfY
MSVGAhssL/SmWli3FSccgxydvKlACcidIIWKQqa3q/QSUEQzC9DgEfMgr7iC1BkT
ZbILboV6UZ5knNsvjEZWuMeogJ8tgZs1hVvKwZizwJ+mEcmsjhIrBYuoL1T6yrOJ
vKFg1jv+Cy4ZwA9Bpk/V3UOir1VyK8dCtyHu6vfosotAdYx8FAuR243gRTMV6Jx8
Jdig2JDIAQMlzVeDpSUHX/K2HXRHxHwfgjbgUjjBu/72r8OfehyhzHXI3K8CFFdf
lO+8nEOJK3y8F1ivgS5uN/8SmcYw/STQYwhrxPuwz3nP8baMum4BB2nnYmpB60sX
3bl5k8QUSw==
-----END CERTIFICATE-----`,
  },
  {
    vendor: "Yubico",
    name: "Yubico Attestation Root 1",
    sourceUrl: "https://developers.yubico.com/PKI/yubico-ca-1.pem",
    sha256:
      "62:76:0C:6A:6E:F9:16:79:F4:54:C8:90:2B:80:FD:00:98:25:B3:F2:5D:A9:0F:1F:BA:CE:2E:C6:58:6C:D5:A8",
    pem: `-----BEGIN CERTIFICATE-----
MIIDPjCCAiagAwIBAgIUXzeiEDJEOTt14F5n0o6Zf/bBwiUwDQYJKoZIhvcNAQEN
BQAwJDEiMCAGA1UEAwwZWXViaWNvIEF0dGVzdGF0aW9uIFJvb3QgMTAgFw0yNDEy
MDEwMDAwMDBaGA85OTk5MTIzMTIzNTk1OVowJDEiMCAGA1UEAwwZWXViaWNvIEF0
dGVzdGF0aW9uIFJvb3QgMTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoCggEB
AMZ6/TxM8rIT+EaoPvG81ontMOo/2mQ2RBwJHS0QZcxVaNXvl12LUhBZ5LmiBScI
Zd1Rnx1od585h+/dhK7hEm7JAALkKKts1fO53KGNLZujz5h3wGncr4hyKF0G74b/
U3K9hE5mGND6zqYchCRAHfrYMYRDF4YL0X4D5nGdxvppAy6nkEmtWmMnwO3i0TAu
csrbE485HvGM4r0VpgVdJpvgQjiTJCTIq+D35hwtT8QDIv+nGvpcyi5wcIfCkzyC
imJukhYy6KoqNMKQEdpNiSOvWyDMTMt1bwCvEzpw91u+msUt4rj0efnO9s0ZOwdw
MRDnH4xgUl5ZLwrrPkfC1/0CAwEAAaNmMGQwHQYDVR0OBBYEFNLu71oijTptXCOX
PfKF1SbxJXuSMB8GA1UdIwQYMBaAFNLu71oijTptXCOXPfKF1SbxJXuSMBIGA1Ud
EwEB/wQIMAYBAf8CAQMwDgYDVR0PAQH/BAQDAgGGMA0GCSqGSIb3DQEBDQUAA4IB
AQC3IW/sgB9pZ8apJNjxuGoX+FkILks0wMNrdXL/coUvsrhzsvl6mePMrbGJByJ1
XnquB5sgcRENFxdQFma3mio8Upf1owM1ZreXrJ0mADG2BplqbJnxiyYa+R11reIF
TWeIhMNcZKsDZrFAyPuFjCWSQvJmNWe9mFRYFgNhXJKkXIb5H1XgEDlwiedYRM7V
olBNlld6pRFKlX8ust6OTMOeADl2xNF0m1LThSdeuXvDyC1g9+ILfz3S6OIYgc3i
roRcFD354g7rKfu67qFAw9gC4yi0xBTPrY95rh4/HqaUYCA/L8ldRk6H7Xk35D+W
Vpmq2Sh/xT5HiFuhf4wJb0bK
-----END CERTIFICATE-----`,
  },
];
