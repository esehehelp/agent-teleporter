package help.esehe.teleporter

import android.app.Activity
import android.os.Bundle
import android.view.View
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.SslErrorHandler
import android.net.http.SslError
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.net.Uri

class MainActivity : Activity() {
    private lateinit var browser: WebView
    private fun safeUrl(uri: Uri): Boolean {
        if (uri.scheme == "https") return !uri.host.isNullOrBlank() && uri.userInfo == null
        if (uri.scheme != "http") return false
        val bytes = uri.host?.split('.')?.mapNotNull { it.toIntOrNull() } ?: return false
        if (bytes.size != 4 || bytes.any { it !in 0..255 }) return false
        return uri.userInfo == null && (bytes[0] == 10 || (bytes[0] == 192 && bytes[1] == 168) ||
            (bytes[0] == 172 && bytes[1] in 16..31))
    }
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val layout = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val address = EditText(this).apply { hint = "http://10.77.0.1:8787/#token=…"; singleLine = true }
        val button = Button(this).apply { text = "Connect" }
        browser = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = false // token stays in page memory only
            settings.allowFileAccess = false
            settings.allowContentAccess = false
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val first = Uri.parse(address.text.toString().trim())
                    return !safeUrl(request.url) || request.url.scheme != first.scheme ||
                        request.url.host != first.host || request.url.port != first.port
                }
                override fun onReceivedSslError(view: WebView, handler: SslErrorHandler, error: SslError) { handler.cancel() }
            }
        }
        layout.addView(address)
        layout.addView(button)
        layout.addView(browser, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(layout)
        button.setOnClickListener {
            val uri = Uri.parse(address.text.toString().trim())
            if (safeUrl(uri)) {
                browser.loadUrl(uri.buildUpon().path("/").clearQuery().build().toString())
                address.visibility = View.GONE; button.visibility = View.GONE
            } else address.error = "HTTPS or private WireGuard IPv4 HTTP URL required"
        }
    }
    @Deprecated("Deprecated in Java")
    override fun onBackPressed() { if (browser.canGoBack()) browser.goBack() else super.onBackPressed() }
    override fun onDestroy() { browser.destroy(); super.onDestroy() }
}
