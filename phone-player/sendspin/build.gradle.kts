import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("org.jetbrains.kotlin.multiplatform")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.android.kotlin.multiplatform.library")
}

kotlin {
    explicitApi()
    androidLibrary {
        namespace = "io.music_assistant.sendspin"
        compileSdk = 36
        minSdk = 28
        compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
        withHostTestBuilder {}
    }
    sourceSets {
        commonMain.dependencies {
            api("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.11.0")
            implementation("org.jetbrains.kotlinx:atomicfu:0.33.0")
            api("io.ktor:ktor-client-core:3.5.2")
            implementation("io.ktor:ktor-client-websockets:3.5.2")
            implementation("io.ktor:ktor-serialization-kotlinx-json:3.5.2")
            implementation("co.touchlab:kermit:2.1.0")
            implementation("dev.whyoleg.cryptography:cryptography-core:0.6.0")
        }
        androidMain.dependencies {
            implementation("dev.whyoleg.cryptography:cryptography-provider-jdk:0.6.0")
            implementation("org.bouncycastle:bcprov-jdk18on:1.85.2")
            implementation("io.github.jaredmdobson:concentus:1.0.2")
        }
        commonTest.dependencies {
            implementation(kotlin("test"))
            implementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.11.0")
            implementation("app.cash.turbine:turbine:1.2.1")
            implementation("io.ktor:ktor-client-mock:3.5.2")
        }
    }
}
