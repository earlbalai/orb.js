plugins {
  id("com.android.library")
  id("org.jetbrains.kotlin.android")
  id("maven-publish")
}

group = "com.earlbalai.orb"
version = "1.0.0"

android {
  namespace = "com.earlbalai.orb"
  compileSdk = 35

  defaultConfig {
    minSdk = 21
    consumerProguardFiles("consumer-rules.pro")
  }

  compileOptions {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
  }
  kotlinOptions { jvmTarget = "17" }

  publishing {
    singleVariant("release") { withSourcesJar() }
  }

  testOptions.unitTests.isReturnDefaultValues = true
}

dependencies {
  // Zero runtime dependencies. Tests only:
  testImplementation("junit:junit:4.13.2")
}

publishing {
  publications {
    register<MavenPublication>("release") {
      groupId = "com.earlbalai.orb"
      artifactId = "orb"
      version = project.version.toString()
      afterEvaluate { from(components["release"]) }
      pom {
        name.set("Orb")
        description.set("Audio-reactive procedural galaxy-in-glass orb for AI voice agents. OpenGL ES 2.0, zero dependencies.")
        url.set("https://github.com/earlbalai/orb.js")
        licenses { license { name.set("MIT"); url.set("https://opensource.org/licenses/MIT") } }
      }
    }
  }
}
