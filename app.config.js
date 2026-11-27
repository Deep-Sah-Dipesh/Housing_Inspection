import fs from "fs";

const VARIANT =
  process.env.APP_VARIANT ||
  process.env.EAS_BUILD_PROFILE ||
  "production";

const isDev = VARIANT === "development";
const isPreview = VARIANT === "preview";

const APP_NAME = isDev
  ? "Housing Dev"
  : isPreview
  ? "Housing Pre"
  : "Housing Inspection";

const ANDROID_PACKAGE = isDev
  ? "com.deepsah.housinginspection.dev"
  : isPreview
  ? "com.deepsah.housinginspection.preview"
  : "com.deepsah.housinginspection";

const resolveGoogleServicesFile = () => {
  const filePath =
    process.env.GOOGLE_SERVICES_JSON ||
    (fs.existsSync("./google-services.json") ? "./google-services.json" : undefined);
  if (!filePath || !fs.existsSync(filePath)) {
    return undefined;
  }
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const hasMatchingClient = (raw.client || []).some(
    (c) => c?.client_info?.android_client_info?.package_name === ANDROID_PACKAGE
  );
  if (!hasMatchingClient) {
    throw new Error(
      `Google services file (${filePath}) is missing an Android client for package "${ANDROID_PACKAGE}".`
    );
  }
  return filePath;
};

export default {
  expo: {
    name: APP_NAME,
    slug: "Housing_Inspection",
    scheme: ANDROID_PACKAGE,
    version: "2.2.4",
    orientation: "portrait",
    icon: "./assets/Housing_Inspection_Logo.png",
    userInterfaceStyle: "light",
    backgroundColor: "#F8FAFC",

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
      package: ANDROID_PACKAGE,

      // <-- This is the important change
      googleServicesFile: resolveGoogleServicesFile(),

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
          image: "./assets/Logo_Deep_sah_splash.png",
          imageWidth: 260,
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
      updateMessage:
        process.env.EXPO_PUBLIC_UPDATE_MESSAGE ||
        "Non-blocking background database sync, Sabar Kantha / Himmatnagar Municipality dataset fix, and empty-share protection.",
    },

    owner: "deep_sah",
  },
};