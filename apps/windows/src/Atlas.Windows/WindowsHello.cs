using System.Runtime.InteropServices;
using Windows.Security.Credentials.UI;

namespace Atlas.Windows;

/// <summary>Windows Hello (fingerprint, face, or PIN), asked through Windows' own prompt over the app's window.</summary>
internal static class WindowsHello
{
    /// <summary>Whether Windows Hello is set up on this computer for the person signed in to Windows.</summary>
    public static async Task<bool> IsAvailableAsync()
    {
        try
        {
            return await UserConsentVerifier.CheckAvailabilityAsync() == UserConsentVerifierAvailability.Available;
        }
        catch (Exception e) when (e is COMException or InvalidOperationException or UnauthorizedAccessException)
        {
            return false;
        }
    }

    /// <summary>Asks for Windows Hello. Null when it confirmed the person; otherwise why not, in words for them.</summary>
    public static async Task<string?> VerifyAsync(IntPtr window, string message)
    {
        UserConsentVerificationResult result;
        try
        {
            result = await UserConsentVerifierInterop.RequestVerificationForWindowAsync(window, message);
        }
        catch (Exception e) when (e is COMException or InvalidOperationException or UnauthorizedAccessException)
        {
            return "Windows Hello couldn't be asked just now.";
        }
        return result switch
        {
            UserConsentVerificationResult.Verified => null,
            UserConsentVerificationResult.Canceled => "Windows Hello was cancelled.",
            UserConsentVerificationResult.RetriesExhausted => "Windows Hello didn't recognise you. Try again.",
            UserConsentVerificationResult.DeviceBusy => "Windows Hello is busy. Try again in a moment.",
            UserConsentVerificationResult.DisabledByPolicy => "Windows Hello is turned off by your organization's policy.",
            UserConsentVerificationResult.NotConfiguredForUser or UserConsentVerificationResult.DeviceNotPresent =>
                "Windows Hello isn't set up on this PC.",
            _ => "Windows Hello couldn't confirm it's you.",
        };
    }
}
