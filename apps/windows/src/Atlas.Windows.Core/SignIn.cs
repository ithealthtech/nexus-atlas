namespace Atlas.Windows.Core;

/// <summary>
/// Browser sign-in: the person signs in to Atlas in their own browser (password and MFA, or a passkey) and approves
/// the app; the browser hands a one-time code back to the app on 127.0.0.1, and the app trades it for a session
/// token. The app never sees or stores the password.
/// </summary>
public static class SignIn
{
    public static readonly TimeSpan Timeout = TimeSpan.FromMinutes(5);

    /// <param name="openBrowser">Opens the address in the default browser.</param>
    public static async Task<TokenResponse> RunAsync(
        AtlasClient client,
        string deviceName,
        Action<Uri> openBrowser,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(client);
        ArgumentNullException.ThrowIfNull(openBrowser);
        var pkce = Pkce.Create();
        using var listener = new LoopbackListener();
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(Timeout);
        openBrowser(client.AuthorizeUri(pkce, listener.RedirectUri, deviceName));
        LoopbackReply reply;
        try
        {
            reply = await listener.WaitAsync(pkce.State, timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new TimeoutException("Sign-in took too long. Try again.");
        }
        if (reply.Code is null)
            throw new AtlasApiException(
                System.Net.HttpStatusCode.Forbidden,
                reply.Error == "access_denied" ? "Sign-in was cancelled in the browser." : "Atlas didn't finish signing in. Try again.",
                reply.Error);
        return await client.ExchangeCodeAsync(reply.Code, pkce.Verifier, listener.RedirectUri, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>The computer's name, as the Account page will show it.</summary>
    public static string DeviceName()
    {
        var name = Environment.MachineName.Trim();
        return name.Length == 0 ? "Windows PC" : name[..Math.Min(name.Length, 60)];
    }
}
