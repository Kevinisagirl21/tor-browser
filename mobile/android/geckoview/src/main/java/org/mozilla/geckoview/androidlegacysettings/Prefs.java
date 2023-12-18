package org.mozilla.geckoview.androidlegacysettings;

import android.content.Context;
import android.content.SharedPreferences;
import org.mozilla.gecko.GeckoAppShell;

import java.util.Locale;

// tor-android-service utils/Prefs.java

/* package */ class Prefs {
    private final static String PREF_BRIDGES_ENABLED = "pref_bridges_enabled";
    private final static String PREF_BRIDGES_LIST = "pref_bridges_list";

    private static SharedPreferences prefs;

    // OrbotConstants
    private final static String PREF_TOR_SHARED_PREFS = "org.torproject.android_preferences";


    // tor-android-service utils/TorServiceUtil.java

    private static void setContext() {
        if (prefs == null) {
            prefs = GeckoAppShell.getApplicationContext().getSharedPreferences(PREF_TOR_SHARED_PREFS,
                    Context.MODE_MULTI_PROCESS);
        }
    }

    public static boolean getBoolean(String key, boolean def) {
        setContext();
        return prefs.getBoolean(key, def);
    }

    public static void putBoolean(String key, boolean value) {
        setContext();
        prefs.edit().putBoolean(key, value).apply();
    }

    public static void putString(String key, String value) {
        setContext();
        prefs.edit().putString(key, value).apply();
    }

    public static String getString(String key, String def) {
        setContext();
        return prefs.getString(key, def);
    }

    public static boolean bridgesEnabled() {
        setContext();
        return prefs.getBoolean(PREF_BRIDGES_ENABLED, false);
    }

    public static String getBridgesList() {
        setContext();
        // was "meek" for (Locale.getDefault().getLanguage().equals("fa")) and "obfs4" for the rest from a 2019 commit
        // but that has stopped representing a good default sometime since so not importing for new users
        String list = prefs.getString(PREF_BRIDGES_LIST, "");
        return list;
    }


}
