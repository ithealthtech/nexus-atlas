using System.Security.Cryptography;
using System.Text;

namespace Atlas.Windows.Core;

/// <summary>Proof Key for Code Exchange (RFC 7636, S256), plus the random state that ties a reply to its request.</summary>
public sealed record Pkce(string Verifier, string Challenge, string State)
{
    public static Pkce Create()
    {
        var verifier = Base64Url(RandomNumberGenerator.GetBytes(32));
        return new Pkce(verifier, ChallengeFor(verifier), Base64Url(RandomNumberGenerator.GetBytes(32)));
    }

    public static string ChallengeFor(string verifier) => Base64Url(SHA256.HashData(Encoding.ASCII.GetBytes(verifier)));

    internal static string Base64Url(byte[] bytes) =>
        Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
