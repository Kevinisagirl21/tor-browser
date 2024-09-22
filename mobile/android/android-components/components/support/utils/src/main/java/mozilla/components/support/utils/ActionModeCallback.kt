package mozilla.components.support.utils

import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem

private val DEFAULT_ACTIONS = listOfNotNull(
    android.R.id.copy,
    android.R.id.cut,
    android.R.id.paste,
    android.R.id.pasteAsPlainText,
    android.R.id.replaceText,
    android.R.id.selectAll,
    android.R.id.shareText,
)

class ActionModeCallback : ActionMode.Callback {
    override fun onPrepareActionMode(mode: ActionMode?, menu: Menu?): Boolean {
        menu?.hideExternalActions()
        return false
    }
    override fun onCreateActionMode(mode: ActionMode?, menu: Menu?) = true
    override fun onActionItemClicked(mode: ActionMode?, item: MenuItem?) = false
    override fun onDestroyActionMode(mode: ActionMode?) {}
}

fun Menu.hideExternalActions() {
    // Skip custom menus created by BasicSelectionActionDelegate
    if (DEFAULT_ACTIONS.any { this.findItem(it) != null }) {
        for (i in 0 until this.size()) {
            val item = this.getItem(i)
            if (!DEFAULT_ACTIONS.contains(item.itemId) &&
                item.intent?.component?.packageName != "com.google.android.marvin.talkback"
            ) {
                item.setVisible(false)
            }
        }
    }
}
