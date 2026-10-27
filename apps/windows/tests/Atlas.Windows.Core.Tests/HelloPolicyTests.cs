using Atlas.Windows.Core;
using Microsoft.Extensions.Time.Testing;
using Xunit;

namespace Atlas.Windows.Core.Tests;

public class HelloPolicyTests
{
    [Fact]
    public void Asks_before_a_secret_then_not_again_for_the_grace_period()
    {
        var time = new FakeTimeProvider();
        var hello = new HelloPolicy(time);
        Assert.True(hello.SecretNeedsCheck);
        hello.Verified();
        Assert.False(hello.SecretNeedsCheck);
        time.Advance(TimeSpan.FromMinutes(4));
        Assert.False(hello.SecretNeedsCheck);
        time.Advance(TimeSpan.FromMinutes(1));
        Assert.True(hello.SecretNeedsCheck);
    }

    [Fact]
    public void A_restricted_password_asks_every_time_whatever_the_settings()
    {
        var hello = new HelloPolicy(new FakeTimeProvider());
        hello.Verified();
        Assert.False(hello.SecretNeedsCheckFor(restricted: false));
        Assert.True(hello.SecretNeedsCheckFor(restricted: true));
        hello.Apply(new AppSettings { HelloForSecrets = false });
        Assert.False(hello.SecretNeedsCheckFor(restricted: false));
        Assert.True(hello.SecretNeedsCheckFor(restricted: true));
    }

    [Fact]
    public void Every_time_means_every_time()
    {
        var hello = new HelloPolicy(new FakeTimeProvider());
        hello.Apply(new AppSettings { HelloGraceMinutes = 0 });
        hello.Verified();
        Assert.True(hello.SecretNeedsCheck);
    }

    [Fact]
    public void Turned_off_never_asks_for_secrets_but_a_lock_still_needs_a_check()
    {
        var hello = new HelloPolicy(new FakeTimeProvider());
        hello.Apply(new AppSettings { HelloForSecrets = false });
        Assert.False(hello.SecretNeedsCheck);
        hello.Lock();
        Assert.True(hello.Locked);
        Assert.True(hello.SecretNeedsCheck);
        hello.Verified();
        Assert.False(hello.Locked);
    }

    [Fact]
    public void Locks_after_the_idle_time_once_and_never_when_set_to_never()
    {
        var hello = new HelloPolicy(new FakeTimeProvider());
        hello.Apply(new AppSettings { LockAfterMinutes = 15 });
        Assert.False(hello.ShouldLock(TimeSpan.FromMinutes(14)));
        Assert.True(hello.ShouldLock(TimeSpan.FromMinutes(15)));
        hello.Lock();
        Assert.False(hello.ShouldLock(TimeSpan.FromHours(2)));

        var never = new HelloPolicy(new FakeTimeProvider());
        never.Apply(new AppSettings { LockAfterMinutes = 0 });
        Assert.False(never.ShouldLock(TimeSpan.FromDays(1)));
    }

    [Fact]
    public void Locking_forgets_the_last_check()
    {
        var hello = new HelloPolicy(new FakeTimeProvider());
        hello.Verified();
        hello.Lock();
        hello.Verified();
        Assert.False(hello.SecretNeedsCheck);
        hello.Lock();
        Assert.True(hello.SecretNeedsCheck);
    }
}
