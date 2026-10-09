import { inflateRawSync } from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { SignedXml } from 'xml-crypto';

// A made-up identity provider for tests. These keys were generated for this file and protect nothing.
export const IDP_CERT = `-----BEGIN CERTIFICATE-----
MIIDLzCCAhegAwIBAgIUMYUVvu7bciMa1LylDk6vetlnXSEwDQYJKoZIhvcNAQEL
BQAwJzElMCMGA1UEAwwcQXRsYXMgdGVzdCBpZGVudGl0eSBwcm92aWRlcjAeFw0y
NjEwMDcwNzUwMjBaFw00NjEwMDIwNzUwMjBaMCcxJTAjBgNVBAMMHEF0bGFzIHRl
c3QgaWRlbnRpdHkgcHJvdmlkZXIwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAwggEK
AoIBAQC5/3ChyHpM+B3UlqznRTxto8NG1BHsujMesj0ta1x4migf1KHldAxYFG5F
43eI72epsenECSkGrQsT88DDuWol8NBW29GldfXjg9mxZa42Rx2dHNj21fwIZ6TP
euJ28TJgRfpD65EFx7aqFwV3ZhlNn68C9IxC/vt2s5y81mENUXNudMjrkVQOP1sY
7eR8VUJ3AKHPSz/EG8323mzqQjY3XTzDwY99ap6pN4uLz5uLsU/mg2OJ/LcGgAoH
jahZw0RUzYRNmADxdbZJw84VX9QyHNWs+G/c60FmYCsTVMGqudkV8YP+eEZrW3xB
bhBo7megUYFTpab+hdCbQK5n7bYnAgMBAAGjUzBRMB0GA1UdDgQWBBQCvXv0i2Y9
HMN1Mn2wtjz85Rof+jAfBgNVHSMEGDAWgBQCvXv0i2Y9HMN1Mn2wtjz85Rof+jAP
BgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQBWmoXrj3E/wVDrcyU/
E/GRsx1js+ojzCQKGAtqR0CQI0L32NFUTGujxE11M33LOFHXUMl0UarsBwj0JeVs
buiwI+MxbzVgEMBU0fcSGoExoxwLrxRWPyngs0FrNm06yraXlRVhRXrzcnlpXnqT
rfHayfToXT0Er2y3vtUta5uT7mJdwU7JrVM8cqZljMTLNG/XM0Gyj+CK7qxJm28L
dTT2Hys9NQBryK1uLZOA5S8nreHJQ0+mQveDy2j+j1fS2nc35R5jG+MoDNAVBhxO
9DF+QtYGFXPLhbQQLyX+mOhwjievzyQFwuye0/FNHgjkh4zwiO4P2knfEpJBFqa2
I5LQ
-----END CERTIFICATE-----`;
const IDP_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC5/3ChyHpM+B3U
lqznRTxto8NG1BHsujMesj0ta1x4migf1KHldAxYFG5F43eI72epsenECSkGrQsT
88DDuWol8NBW29GldfXjg9mxZa42Rx2dHNj21fwIZ6TPeuJ28TJgRfpD65EFx7aq
FwV3ZhlNn68C9IxC/vt2s5y81mENUXNudMjrkVQOP1sY7eR8VUJ3AKHPSz/EG832
3mzqQjY3XTzDwY99ap6pN4uLz5uLsU/mg2OJ/LcGgAoHjahZw0RUzYRNmADxdbZJ
w84VX9QyHNWs+G/c60FmYCsTVMGqudkV8YP+eEZrW3xBbhBo7megUYFTpab+hdCb
QK5n7bYnAgMBAAECggEAUHbxgwv33NR6Ez4cDvEk80mlcT7NglwLQXxaewu3NXV7
ZknWwC00Keaszg9Z5yOq9P7C4swTs4+o+zi4a/QKt982Ql1WlP4zIfooc1ZJx7F8
XjvcoOxx3DD6W8gNsOcno/6iBkAivR1pKKxM8Rp6V9p9HAovo8wrfW62n/segWO9
7ub1U4yS6V5ar3KoRtuIsB8DatSO6+TyohZSM+z4Py5sfJtozf4BdVJQdCCtVjzd
EozEcYo9ulJYQvtCWKIvPRWy1KD97mppVqBNh0tYtNkLb3lHJozS2/IdSFDGC4XR
AiR5sDRtki/8JNHs1utwsWkA4XuiH/4Xq0dt97t+AQKBgQDrtrj3fYxnrba1n345
nsB9oHO15MPUjJCNnmQQHTPYDR8DCO3vcldzG+M2fqlVJHYyWfuPqO56gDq3ythd
quj5EWqZIgWaV9JQ2QBfxkxDr1NEcQBGT11uQ//jG11Lsszu5kOVhIUirV7BVEmA
whHPbHp/U6uISSyMb6OoAYPFRQKBgQDKAV5z3PRlPpJvB3lG84GO/XzafavhrYpl
2BuyPAQlImGo3ylkJeJ9JbXxBTGHyRbS3Q5EALTQ/3rlZ0t97z7GEaTxJQlGrX/u
Y2KZSs6CD+sU6d4+EbUuEiaN8TGyY+Gtb+s5ae4/a6li5qi8W4SwNn9LS7Xl069y
Bu0fQaIWewKBgQCHMrkJC3P7C8JejmrB9fKGm/+CdwJz6WQINq9CJt3TsEL3ZKnE
y5qpJXe/jAroEQ/SdZY6ojSXAvGq9agAocUbBwhTaRY5nuG9CZqTVJPtxqRF/2Ke
8WqvkkU1KD7s6lNtO5nMKsSKTVKqJQQ73BSHGrtwSLd8ZiwtKON/u86u2QKBgAZf
Aq6e0mp7Db1IvA970KNE5XIysoAcrBfIOB9n+y18px3fY/vPohQWY2Wlp0lEE181
L6T/bLSGykZ/+oaPTCiNF+mvJFrBUB6hrdNt45OAkwaG1caZYmCAnAywBcQ9mDmT
JRUbfTMs3xvKcJn4PPgdz+f9DFCiW486HrJ0rHsPAoGAZl0Djig3optqQIDQXQyA
wagqBDjuycKTOS4eAJc8oVwa7iLednTnHcGNKajByrGVh8nZ/+aV1gjzPD5xsr7k
OzKIzh1peuTA9yhmMH3/K9E8uYTyhgvEet2CMNvtonrg1YE2YaG4UsIg5GsTfhYz
x0lZiPnqeyadtIHvKoiZS3w=
-----END PRIVATE KEY-----`;
/** A second, unrelated key pair: what an attacker signing their own response would have. */
export const OTHER_CERT = `-----BEGIN CERTIFICATE-----
MIIDDzCCAfegAwIBAgIUcOKKgAruKl6uuvETrNEDca1WEcwwDQYJKoZIhvcNAQEL
BQAwFzEVMBMGA1UEAwwMU29tZW9uZSBlbHNlMB4XDTI2MTAwNzA3NTAyMFoXDTQ2
MTAwMjA3NTAyMFowFzEVMBMGA1UEAwwMU29tZW9uZSBlbHNlMIIBIjANBgkqhkiG
9w0BAQEFAAOCAQ8AMIIBCgKCAQEAszvaIdyfWpvR6fpSPSmjjTIDESOFb4j478qt
HmrrYqwKbknpG0l++RUkFXBTYHkbi/z/7FbS1kMsM8/aBOEvP+MT+5fdUorojg4C
7zjpuQCs7gWgN9GBB46TbwSPLTOHy7qhauu7vF+FaMhN1zDD0fyRbtlKF1xB/ryI
9590IRQPFGwOJntcYel7IKQiS0sBLK1MyUmKpa2TTyIz/dHq0QlWMnx+hDAIz7q4
r6Ssh+blrfIQpS4wktSTwzolfcYc8i9081Tg1HwXCsHaz7gWBr5DnJbE0W0EsRsJ
uxPlkrHBXwfBZ3ERTQE/pVMY3aMWe4FQndL9qob+oP2mD8uYgwIDAQABo1MwUTAd
BgNVHQ4EFgQU/gMrTYSm+NTMylytOR7PUw47qXwwHwYDVR0jBBgwFoAU/gMrTYSm
+NTMylytOR7PUw47qXwwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOC
AQEAqPInbiegugqCG5oqtGKAhvSsk9s2iwyLOUds/QULzWW7aMIXI8SwXCVHn5Cg
HmkEPfnPYqJMoWGB7RlWsxA9GkTe5lWSanpaXEtvVr0ytq3id/CgxXqmeqNgm1mm
PijSpAJET0pQCj9h6VQT5BgmjWmuJbdoSz265JczIpsm20cn6psLXnskY+O6VLjZ
N+MmfinZBCLuoE3ZP7JyulHkcmekHmwNn50PUqGS/EJ1AdnwWOIrpY9GdLTSaJnK
BDyafP4Bcv7H2F4CfS+PFLBFTS+YY64bf1BE9+vcTUD/1pH5tYGDcc5hmAhR6nXV
RNsaeVzEm0sYjWcYqnOi9dsi6Q==
-----END CERTIFICATE-----`;
const OTHER_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCzO9oh3J9am9Hp
+lI9KaONMgMRI4VviPjvyq0eautirApuSekbSX75FSQVcFNgeRuL/P/sVtLWQywz
z9oE4S8/4xP7l91SiuiODgLvOOm5AKzuBaA30YEHjpNvBI8tM4fLuqFq67u8X4Vo
yE3XMMPR/JFu2UoXXEH+vIj3n3QhFA8UbA4me1xh6XsgpCJLSwEsrUzJSYqlrZNP
IjP90erRCVYyfH6EMAjPurivpKyH5uWt8hClLjCS1JPDOiV9xhzyL3TzVODUfBcK
wdrPuBYGvkOclsTRbQSxGwm7E+WSscFfB8FncRFNAT+lUxjdoxZ7gVCd0v2qhv6g
/aYPy5iDAgMBAAECggEAP4wE9uSGC1Ybwt1hsxXESxdkRvtVIApsWHh/kL1P35gn
ypqh727Lefyo4oEEzruhrKxzAJR4BEeksGoNXpWIbxpPx3A8pDtj4JnPKIoBM/qt
VWbhO2koWkmOtFnleZ0/lFgDSylxUoR7hH8gOh+sDhOCbM7Vmhq3u12VIlaCkgc0
m9B1gX457UbB+tktzM9IdgMGZ5YhcXTLfIkOz8FG3XXMR43DmTP9R71fDaonClg3
fjXg0i/q35X2E4CBNyAk+KeQSymLqz/j4QYEjvkHPCTNJ0lO80os3eciL+iPCLim
mxB8d1ACfJ7MC/yCyFB5exrdS+5b2KiOR7Uet+4A4QKBgQD9MAVNM0x80U75jVaU
f8QbL1wY74soVJYpnWhm8fvtGzyu75jXdV+c9zTOVJ/lxVRslg4npZ+KAlBLYnJP
cWwrxgydOEJb3zdge7o3ncLMpOtG3oiQmufLjyVmD5yaUd1vo9a+bxH82xBDM1UN
TehOBbwtt+BkWtt0/M8c41Y51QKBgQC1OYgwHatJu99OkbnIE764c4+7jlW1IMQ+
RWWXXE5Q7WhriDtyzYHzOv1E4pA0Zkx4Z9E8PrNkmQ6ZRgvIkSl26ih5IKHj9php
KZrbPZ59SHvY9Puri/V3cjXNuQJYU+o6r5x1VTh/yqOi/1x/8KWQ2VHCAKhYGV84
jOtvbOyc9wKBgB/ZTpFrho+c9MZHlUCQ4eZZishIOcUU/t61QlDQ19P3vSZ0VVGl
HiXsouPhmUuaCwitx5INL4h4ygjxlVeQ+P54p1WPoilUZu7oIYClg7+ib0Y28A7g
rY/ZreasyBJRgf1tKrJB3o1kMSOC7YwC5NoLtqQ5oSx+kWSh+Ju1rT8RAoGAJaBf
VVYjpTh7oc2B3De1Roi/0/o2c1ftRtyTvjxtCkJwhrsPVMO0cnLR+QZtWGPRBsLP
X4nJJ17b+BjiA2+YQ1dUtel/k1w0wsjfnRuLF4oAJMigpDp36aft4dvCz+IEZNDn
VDkwdN/237XTV8D4Lz3fyr7mNPx3l78ydr0P13sCgYEA+xTPIME1KVRN8EZDBe39
v3okMV1FJSj0g8AkNp8S1KgqeyiKoKgCxLkxCWA1K/ONkRFT5J+oOCvZ25xOO4OI
+2jCDJ2S451jB6V3yjQHxkwD9p+18F2P4lRvX7cfjJC07mBQXRLchfzZKVvW20wH
dz7K1XYaHo5N7u14D1ROz4I=
-----END PRIVATE KEY-----`;

export const IDP_ISSUER = 'https://idp.example.test/saml';
export const IDP_SSO_URL = 'https://idp.example.test/sso';

/** The ID of the AuthnRequest inside the address Atlas sends the browser to. */
export function requestIdFrom(location: string): string {
  const request = new URL(location).searchParams.get('SAMLRequest')!;
  const xml = inflateRawSync(Buffer.from(request, 'base64')).toString('utf8');
  return /\bID="([^"]+)"/.exec(xml)![1]!;
}

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/** A SAML response as an identity provider would post it, base64-encoded. Every part can be made wrong. */
export function samlResponse(options: {
  inResponseTo: string;
  acsUrl: string;
  audience: string;
  nameId: string;
  attributes?: Record<string, string>;
  issuer?: string;
  /** Sign with the unrelated key instead of the provider's. */
  forged?: boolean;
  /** Leave the assertion unsigned. */
  unsigned?: boolean;
  /** Minutes from now the assertion stops being valid (negative: already expired). */
  validForMinutes?: number;
  /** Change the name ID after signing, as someone tampering with a captured response would. */
  tamperNameId?: string;
}): string {
  const now = new Date();
  const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
  const issuer = escape(options.issuer ?? IDP_ISSUER);
  const until = at(options.validForMinutes ?? 5);
  const assertionId = `_${randomBytes(16).toString('hex')}`;
  const attributes = Object.entries(options.attributes ?? {})
    .map(
      ([name, value]) =>
        `<saml:Attribute Name="${escape(name)}"><saml:AttributeValue>${escape(value)}</saml:AttributeValue></saml:Attribute>`,
    )
    .join('');
  const xml =
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_${randomBytes(16).toString('hex')}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${escape(options.acsUrl)}" InResponseTo="${escape(options.inResponseTo)}">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>` +
    `<saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${now.toISOString()}">` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent">${escape(options.nameId)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${until}" Recipient="${escape(options.acsUrl)}" InResponseTo="${escape(options.inResponseTo)}"/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${at(-1)}" NotOnOrAfter="${until}"><saml:AudienceRestriction><saml:Audience>${escape(options.audience)}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="${assertionId}"><saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext></saml:AuthnStatement>` +
    (attributes ? `<saml:AttributeStatement>${attributes}</saml:AttributeStatement>` : '') +
    `</saml:Assertion></samlp:Response>`;
  let signed = xml;
  if (!options.unsigned) {
    const signer = new SignedXml({
      privateKey: options.forged ? OTHER_KEY : IDP_KEY,
      signatureAlgorithm: 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256',
      canonicalizationAlgorithm: 'http://www.w3.org/2001/10/xml-exc-c14n#',
    });
    signer.addReference({
      xpath: "//*[local-name(.)='Assertion']",
      transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', 'http://www.w3.org/2001/10/xml-exc-c14n#'],
      digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
    });
    signer.computeSignature(xml, {
      location: { reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']", action: 'after' },
    });
    signed = signer.getSignedXml();
  }
  if (options.tamperNameId)
    signed = signed.replace(
      `>${escape(options.nameId)}</saml:NameID>`,
      `>${escape(options.tamperNameId)}</saml:NameID>`,
    );
  return Buffer.from(signed, 'utf8').toString('base64');
}
