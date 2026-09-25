plugins { id("com.android.application") }
android { namespace = "help.esehe.teleporter"; compileSdk = 35
    defaultConfig { applicationId = "help.esehe.teleporter"; minSdk = 26; targetSdk = 35; versionCode = 1; versionName = "0.1.0" }
}
dependencies { implementation("com.google.android.gms:play-services-code-scanner:16.1.0") }
