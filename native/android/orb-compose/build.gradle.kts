plugins {
  id("com.android.library")
  id("org.jetbrains.kotlin.android")
  id("org.jetbrains.kotlin.plugin.compose")
  id("maven-publish")
}

group = "com.earlbalai.orb"
version = "1.0.0"

android {
  namespace = "com.earlbalai.orb.compose"
  compileSdk = 35
  defaultConfig { minSdk = 21 }
  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }
  buildFeatures { compose = true }
  publishing { singleVariant("release") { withSourcesJar() } }
}

dependencies {
  api(project(":orb"))
  val composeBom = platform("androidx.compose:compose-bom:2024.10.01")
  implementation(composeBom)
  implementation("androidx.compose.ui:ui")
  implementation("androidx.compose.foundation:foundation")
}

publishing {
  publications {
    register<MavenPublication>("release") {
      groupId = "com.earlbalai.orb"
      artifactId = "orb-compose"
      version = project.version.toString()
      afterEvaluate { from(components["release"]) }
    }
  }
}
