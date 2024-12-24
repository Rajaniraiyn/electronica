import {app, BrowserWindow} from "electron"
import {pageURL} from "electron"

app.whenReady().then(()=>{
    const window = new BrowserWindow();

    window.loadURL(pageURL("home"))
})