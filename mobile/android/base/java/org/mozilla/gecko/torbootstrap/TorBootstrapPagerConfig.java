/* -*- Mode: Java; c-basic-offset: 4; tab-width: 4; indent-tabs-mode: nil; -*-
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

package org.mozilla.gecko.torbootstrap;

import android.os.Bundle;
import android.util.Log;
import org.mozilla.gecko.GeckoSharedPrefs;
import org.mozilla.gecko.R;
import org.mozilla.gecko.Telemetry;
import org.mozilla.gecko.TelemetryContract;
import org.mozilla.gecko.Experiments;

import java.util.LinkedList;
import java.util.List;

public class TorBootstrapPagerConfig {
    public static final String LOGTAG = "TorBootstrapPagerConfig";

    public static final String KEY_IMAGE = "imageRes";
    public static final String KEY_TEXT = "textRes";
    public static final String KEY_SUBTEXT = "subtextRes";
    public static final String KEY_CTATEXT = "ctatextRes";

    public static List<TorBootstrapPanelConfig> getDefaultConnectPanel() {
         final List<TorBootstrapPanelConfig> panels = new LinkedList<>();
         panels.add(SimplePanelConfigs.connectPanelConfig);

         return panels;
    }

    public static List<TorBootstrapPanelConfig> getDefaultBootstrapPanel() {
         final List<TorBootstrapPanelConfig> panels = new LinkedList<>();
         panels.add(SimplePanelConfigs.bootstrapPanelConfig);
         panels.add(SimplePanelConfigs.torLogPanelConfig);

         return panels;
    }

    public static class TorBootstrapPanelConfig {

        private String classname;
        private int titleRes;
        private Bundle args;

        public TorBootstrapPanelConfig(String resource, int titleRes) {
            this(resource, titleRes, -1, -1, -1, true);
        }

        public TorBootstrapPanelConfig(String classname, int titleRes, int imageRes, int textRes, int subtextRes) {
            this(classname, titleRes, imageRes, textRes, subtextRes, false);
        }

        private TorBootstrapPanelConfig(String classname, int titleRes, int imageRes, int textRes, int subtextRes, boolean isCustom) {
            this.classname = classname;
            this.titleRes = titleRes;

            if (!isCustom) {
                this.args = new Bundle();
                this.args.putInt(KEY_IMAGE, imageRes);
                this.args.putInt(KEY_TEXT, textRes);
                this.args.putInt(KEY_SUBTEXT, subtextRes);
            }
        }

        public String getClassname() {
            return this.classname;
        }

        public int getTitleRes() {
            return this.titleRes;
        }

        public Bundle getArgs() {
            return args;
        }
    }

    private static class SimplePanelConfigs {
        public static final TorBootstrapPanelConfig connectPanelConfig = new TorBootstrapPanelConfig(TorBootstrapPanel.class.getName(), R.string.firstrun_panel_title_welcome);
        public static final TorBootstrapPanelConfig bootstrapPanelConfig = new TorBootstrapPanelConfig(TorBootstrapPanel.class.getName(), R.string.firstrun_panel_title_welcome);
        public static final TorBootstrapPanelConfig torLogPanelConfig = new TorBootstrapPanelConfig(TorBootstrapLogPanel.class.getName(), R.string.firstrun_panel_title_privacy);

    }
}
