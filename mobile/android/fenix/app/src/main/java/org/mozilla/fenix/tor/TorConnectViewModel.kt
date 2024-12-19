package org.mozilla.fenix.tor

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModel
import mozilla.components.browser.engine.gecko.GeckoEngine
import org.mozilla.fenix.ext.components
import org.mozilla.geckoview.TorIntegrationAndroid

class TorConnectViewModel(application: Application) : AndroidViewModel(application) {
    private val components = getApplication<Application>().components


    private fun getTorIntegration(): TorIntegrationAndroid {
        return (components.core.engine as GeckoEngine).getTorIntegrationController()
    }


}
