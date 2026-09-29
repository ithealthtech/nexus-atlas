using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Atlas.Windows.Core;

/// <summary>Encrypts data for the signed-in Windows user.</summary>
public interface IDataProtector
{
    byte[] Protect(byte[] data);
    byte[] Unprotect(byte[] data);
}

/// <summary>DPAPI (Windows' per-user data protection): only this Windows account on this computer can read it.</summary>
[SupportedOSPlatform("windows")]
public sealed class DpapiProtector : IDataProtector
{
    // Ties the ciphertext to this app, so another app using DPAPI for the same user can't be tricked into decrypting it.
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("MSP Atlas for Windows · session v1");

    public byte[] Protect(byte[] data) => ProtectedData.Protect(data, Entropy, DataProtectionScope.CurrentUser);

    public byte[] Unprotect(byte[] data) => ProtectedData.Unprotect(data, Entropy, DataProtectionScope.CurrentUser);
}

/// <summary>What the app keeps between runs. No secrets from the vault are ever stored (no offline copy in v1).</summary>
public sealed record AppSettings
{
    public string? AtlasUrl { get; init; }
    public bool StartWithWindows { get; init; }
    public bool NotifyExpiring { get; init; } = true;
}

/// <summary>
/// The app's local storage: settings as plain JSON, and the session token encrypted with DPAPI. Nothing else is written.
/// </summary>
public sealed class SecureStore(string folder, IDataProtector protector)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { WriteIndented = true };
    private string SettingsPath => Path.Combine(folder, "settings.json");
    private string TokenPath => Path.Combine(folder, "session.bin");

    /// <summary>%LOCALAPPDATA%\Atlas for Windows (not roamed: the token belongs to this computer).</summary>
    public static string DefaultFolder() =>
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Atlas for Windows");

    public AppSettings LoadSettings()
    {
        try
        {
            return File.Exists(SettingsPath)
                ? JsonSerializer.Deserialize<AppSettings>(File.ReadAllText(SettingsPath), Json) ?? new AppSettings()
                : new AppSettings();
        }
        catch (JsonException)
        {
            return new AppSettings();
        }
    }

    public void SaveSettings(AppSettings settings)
    {
        Directory.CreateDirectory(folder);
        WriteAtomically(SettingsPath, Encoding.UTF8.GetBytes(JsonSerializer.Serialize(settings, Json)));
    }

    /// <summary>The session token, bound to the Atlas address it was issued by.</summary>
    public string? LoadToken(AtlasAddress address)
    {
        ArgumentNullException.ThrowIfNull(address);
        if (!File.Exists(TokenPath))
            return null;
        try
        {
            var text = Encoding.UTF8.GetString(protector.Unprotect(File.ReadAllBytes(TokenPath)));
            var split = text.IndexOf('\n', StringComparison.Ordinal);
            // A token for a different server is never sent anywhere.
            return split > 0 && text[..split] == address.ToString() ? text[(split + 1)..] : null;
        }
        catch (CryptographicException)
        {
            // Another Windows account's file, or damaged: sign in again.
            return null;
        }
    }

    public void SaveToken(AtlasAddress address, string token)
    {
        ArgumentNullException.ThrowIfNull(address);
        Directory.CreateDirectory(folder);
        WriteAtomically(TokenPath, protector.Protect(Encoding.UTF8.GetBytes($"{address}\n{token}")));
    }

    public void ForgetToken()
    {
        if (File.Exists(TokenPath))
            File.Delete(TokenPath);
    }

    private static void WriteAtomically(string path, byte[] bytes)
    {
        var temp = path + ".tmp";
        File.WriteAllBytes(temp, bytes);
        File.Move(temp, path, overwrite: true);
    }
}
