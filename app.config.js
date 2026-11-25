import fs from "fs";

export default {
  expo: {
    name: "Housing Inspection",
    slug: "Housing_Inspection",
    scheme: "com.deepsah.housinginspection",
    version: "2.2.0",
    orientation: "portrait",
    icon: "./assets/Housing_Inspection_Logo.png",
    userInterfaceStyle: "light",

    // --- EAS UPDATE SETTINGS ---
    // Channel routing is managed per build profile in eas.json (preview / production)
    updates: {
      url: "https://u.expo.dev/ffe75714-4533-4d6f-927e-9a679e0a8db3",
    },
    runtimeVersion: {
      policy: "appVersion"
    },
    // ---

    ios: {
      supportsTablet: true,
      buildNumber: "7",
    },

    android: {
      versionCode: 7,
      adaptiveIcon: {
        backgroundColor: "#E6F4FE",
        foregroundImage: "./assets/android-icon-foreground.png",
        backgroundImage: "./assets/android-icon-background.png",
        monochromeImage: "./assets/android-icon-monochrome.png",
      },
      package: "com.deepsah.housinginspection",

      // <-- This is the important change
      googleServicesFile:
        process.env.GOOGLE_SERVICES_JSON ||
        (fs.existsSync("./google-services.json") ? "./google-services.json" : undefined),

      permissions: [
        "android.permission.CAMERA",
        "android.permission.ACCESS_FINE_LOCATION",
        "android.permission.ACCESS_COARSE_LOCATION",
        "android.permission.RECORD_AUDIO",
      ],
    },

    web: {
      favicon: "./assets/favicon.png",
    },

    plugins: [
      "expo-router",
      "expo-camera",
      "expo-location",
      "expo-font",
      "expo-sqlite",
      [
        "expo-splash-screen",
        {
          image: "./assets/Logo_Deep_sah.png",
          imageWidth: 250,
          resizeMode: "contain",
          backgroundColor: "#ffffff",
        },
      ],
    ],

    extra: {
      router: {
        origin: false,
      },
      eas: {
        projectId: "ffe75714-4533-4d6f-927e-9a679e0a8db3",
      },
    },

    owner: "deep_sah",
  },
};