using System.Security.Cryptography;

namespace Atlas.Windows.Core;

/// <summary>
/// Makes random passwords from the operating system's secure random source: letters, digits, and symbols, with at
/// least one of each, and none of the characters that are easy to misread (0 O o 1 l I |).
/// </summary>
public static class PasswordGenerator
{
    private const string Lower = "abcdefghijkmnpqrstuvwxyz";
    private const string Upper = "ABCDEFGHJKLMNPQRSTUVWXYZ";
    private const string Digits = "23456789";
    private const string Symbols = "!@#$%^&*-_=+?";

    public static string Generate(int length = 20)
    {
        if (length < 8 || length > 128)
            throw new ArgumentOutOfRangeException(nameof(length), "Between 8 and 128 characters.");
        var sets = new[] { Lower, Upper, Digits, Symbols };
        var all = string.Concat(sets);
        var chars = new char[length];
        // One from each set, the rest from all of them, then shuffled so the guaranteed ones aren't first.
        for (var i = 0; i < sets.Length; i++)
            chars[i] = sets[i][RandomNumberGenerator.GetInt32(sets[i].Length)];
        for (var i = sets.Length; i < length; i++)
            chars[i] = all[RandomNumberGenerator.GetInt32(all.Length)];
        for (var i = length - 1; i > 0; i--)
        {
            var j = RandomNumberGenerator.GetInt32(i + 1);
            (chars[i], chars[j]) = (chars[j], chars[i]);
        }
        return new string(chars);
    }
}
