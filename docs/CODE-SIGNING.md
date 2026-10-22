# Code signing Atlas for Windows

Without a signature, Windows SmartScreen warns about the Atlas for Windows setup program ("Windows protected your PC", unknown publisher), and people have to choose **More info → Run anyway**. Once releases are signed, setup shows your organization as the publisher.

The release workflow (`.github/workflows/release.yml`, the **Atlas for Windows** job) signs with **Azure Artifact Signing** (previously called Trusted Signing) whenever it's set up. Until then, releases are built unsigned, exactly as before, and the run shows a warning.

When signing is set up, each release signs:

1. the app's own files, in both the x64 and ARM64 builds, before they're packed into the setup program;
2. the setup program itself.

The checksum (`AtlasForWindowsSetup.exe.sha256`) is taken after signing. The job fails if a release that should be signed isn't.

## What it costs

Artifact Signing's Basic plan is about US$10 a month and covers far more signatures than Atlas needs. You need an Azure subscription to pay for it.

## Setting it up

You do these steps once, in the Azure portal and on GitHub. Nothing secret is stored in the repository: GitHub signs in to Azure with OpenID Connect, so there is no password or certificate to look after.

1. **Create the signing account.**
   - In the Azure portal, create an **Artifact Signing account** in a resource group of your choice.
   - Note its **name** and its **endpoint**. The endpoint depends on the region, for example `https://eus.codesigning.azure.net/` for East US.
2. **Verify your organization.**
   - Under the account, create an **Identity validation** for *Organization* and *Public* trust, and give it your business's legal details.
   - Microsoft checks them. This can take a few business days, and Microsoft sets the rules on which organizations qualify.
   - Only a verified organization can sign.
3. **Create a certificate profile.**
   - Create one of type **Public Trust**, using the identity validation from step 2.
   - Note the profile's **name**. Your organization's name, as verified, is what Windows will show as the publisher.
4. **Create the identity GitHub signs in as.**
   - In Microsoft Entra ID, go to **App registrations → New registration**. Name it, for example, `atlas-release-signing`.
   - Note its **Application (client) ID** and the **Directory (tenant) ID**.
   - Under **Certificates & secrets → Federated credentials**, add one with these values:
     - Scenario: *GitHub Actions deploying Azure resources*
     - Organization: `ithealthtech`
     - Repository: `nexus-atlas`
     - Entity type: **Environment**
     - Environment: `release`
5. **Let it sign.**
   - On the certificate profile, go to **Access control (IAM) → Add role assignment**.
   - Give the app registration from step 4 the role **Artifact Signing Certificate Profile Signer**.
6. **Tell GitHub.** In the repository, open **Settings → Secrets and variables → Actions**.
   - Add these **secrets**:

     | Secret | Value |
     |---|---|
     | `AZURE_CLIENT_ID` | the app registration's Application (client) ID |
     | `AZURE_TENANT_ID` | the Directory (tenant) ID |
     | `AZURE_SUBSCRIPTION_ID` | the subscription the signing account is in |

   - Add these **variables**:

     | Variable | Value |
     |---|---|
     | `ARTIFACT_SIGNING_ENDPOINT` | the endpoint from step 1, for example `https://eus.codesigning.azure.net/` |
     | `ARTIFACT_SIGNING_ACCOUNT` | the signing account's name |
     | `ARTIFACT_SIGNING_PROFILE` | the certificate profile's name |

The next release is signed. To check it, right-click the downloaded `AtlasForWindowsSetup.exe`, choose **Properties → Digital Signatures**, and look for your organization's name.

## Good to know

- **SmartScreen reputation builds with downloads.** A newly signed program can still be warned about for a short while, until enough people have run it.
- **Older releases stay unsigned.** Only releases built after signing is set up are signed, and the in-app update installs them like any other.
- **Turning it off.** Delete the `ARTIFACT_SIGNING_ACCOUNT` variable to go back to unsigned releases.
