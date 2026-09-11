using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace NeteaseCloudUploader
{
    internal sealed class LoginForm : Form
    {
        private readonly WebView2 browser;
        private readonly Timer cookieTimer;
        private bool checkingCookies;
        private bool credentialSaved;

        public int ExitCode { get; private set; }

        public LoginForm()
        {
            ExitCode = 11;
            Text = "网易云音乐登录";
            Width = 1100;
            Height = 800;
            StartPosition = FormStartPosition.CenterScreen;

            browser = new WebView2();
            browser.Dock = DockStyle.Fill;
            Controls.Add(browser);

            cookieTimer = new Timer();
            cookieTimer.Interval = 1000;
            cookieTimer.Tick += async delegate { await CheckCookiesAsync(); };
            Shown += async delegate { await InitializeAsync(); };
        }

        private async Task InitializeAsync()
        {
            try
            {
                string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
                string profilePath = Path.Combine(localAppData, "netease-cloud-uploader", "webview2-profile");
                Directory.CreateDirectory(profilePath);

                CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(null, profilePath);
                await browser.EnsureCoreWebView2Async(environment);
                browser.CoreWebView2.Settings.AreDevToolsEnabled = false;
                browser.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
                browser.CoreWebView2.NavigationCompleted += NavigationCompleted;
                browser.CoreWebView2.Navigate("https://music.163.com/#/login");
                cookieTimer.Start();
            }
            catch
            {
                ExitCode = 10;
                Close();
            }
        }

        private void NavigationCompleted(object sender, CoreWebView2NavigationCompletedEventArgs eventArgs)
        {
            if (!eventArgs.IsSuccess && !credentialSaved)
            {
                ExitCode = 12;
                Close();
            }
        }

        private async Task CheckCookiesAsync()
        {
            if (checkingCookies || credentialSaved || browser.CoreWebView2 == null) return;

            checkingCookies = true;
            try
            {
                IReadOnlyList<CoreWebView2Cookie> cookies = await browser.CoreWebView2.CookieManager.GetCookiesAsync("https://music.163.com/");
                bool hasMusicU = false;
                List<string> pairs = new List<string>();

                foreach (CoreWebView2Cookie cookie in cookies)
                {
                    if (String.Equals(cookie.Name, "MUSIC_U", StringComparison.Ordinal) && !String.IsNullOrEmpty(cookie.Value))
                    {
                        hasMusicU = true;
                    }
                    pairs.Add(cookie.Name + "=" + cookie.Value);
                }
                if (!hasMusicU) return;

                SaveEncryptedCredential(String.Join("; ", pairs.ToArray()));
                credentialSaved = true;
                ExitCode = 0;
                cookieTimer.Stop();
                MessageBox.Show(this, "登录成功，登录态已加密保存", "网易云音乐登录", MessageBoxButtons.OK, MessageBoxIcon.Information);
                Close();
            }
            catch
            {
                ExitCode = 13;
                cookieTimer.Stop();
                Close();
            }
            finally
            {
                checkingCookies = false;
            }
        }

        private static void SaveEncryptedCredential(string cookieHeader)
        {
            string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
            string statePath = Path.Combine(localAppData, "netease-cloud-uploader");
            string credentialPath = Path.Combine(statePath, "session.dpapi");
            Directory.CreateDirectory(statePath);
            byte[] protectedBytes = ProtectedData.Protect(Encoding.UTF8.GetBytes(cookieHeader), null, DataProtectionScope.CurrentUser);
            File.WriteAllText(credentialPath, Convert.ToBase64String(protectedBytes), new UTF8Encoding(false));
        }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main()
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            LoginForm form = new LoginForm();
            Application.Run(form);
            return form.ExitCode;
        }
    }
}
