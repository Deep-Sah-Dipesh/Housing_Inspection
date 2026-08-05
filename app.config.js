export default {
  expo: {
    name: "Housing Inspection",
    slug: "Housing_Inspection",
    scheme: "com.deepsah.housinginspection",
    version: "1.2.1",
    orientation: "portrait",
    icon: "./assets/Housing_Inspection_Logo.png",
    userInterfaceStyle: "light",

    // --- EAS UPDATE SETTINGS ---
    updates: {
      url: "https://u.expo.dev/ffe75714-4533-4d6f-927e-9a679e0a8db3",
      channel: "preview"
    },
    runtimeVersion: {
      policy: "appVersion"
    },
    // ---

    ios: {
      supportsTablet: true,
      buildNumber: "5",
    },

    android: {
      versionCode: 5,
      adaptiveIcon: {
        backgroundColor: "#E6F4FE",
        foregroundImage: "./assets/android-icon-foreground.png",
        backgroundImage: "./assets/android-icon-background.png",
        monochromeImage: "./assets/android-icon-monochrome.png",
      },
      package: "com.deepsah.housinginspection",

      // <-- This is the important change
      googleServicesFile: process.env.GOOGLE_SERVICES_JSON,

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