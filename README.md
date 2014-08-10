# TiMeteor (Beta)

__Use the Power of Meteor in your Titanium App.__

* [__Meteor__](http://meteor.com) is a full stack javascript platform to write web apps, which is based on the "reactive programming" paradigm. 
* [__Titanium__](http://www.appcelerator.com/titanium/) is a cross-platform Framework to build native Apps, driven by javascript code

__TiMeteor__ exposes the full Meteor API to your Titanium app. 

This allows you use the Meteor javascript API to build a website frontend, website backend and native apps for iOS and Android. Your Data will be automatically in sync and you can use the same API and Mongo queries, in the browser, on the server and in your app. 

This is not considered to be used for production releases, please feel free to raise issues to get this library stable. 

Version: 0.1

**Table of Contents** 

- [TiMeteor (Beta)](#user-content-timeteor-beta)
	- [Features](#user-content-features)
	- [Module Dependencies](#user-content-module-dependencies)
	- [Installation](#user-content-installation)
		- [Alloy](#user-content-alloy)
		- [Classic](#user-content-classic)
	- [Usage](#user-content-usage)
		- [Initialization Code](#user-content-initialization-code)
		- [Basic Example](#user-content-basic-example)
			- [Server](#user-content-server)
			- [Titanium](#user-content-titanium)
	- [Documentation](#user-content-documentation)
		- [TiMeteor API](#user-content-timeteor-api)
			- [Methods](#user-content-methods)
		- [Meteor API](#user-content-meteor-api)
	- [Plugins](#user-content-plugins)
		- [WebView](#user-content-webview)
			- [Methods](#user-content-methods-1)
		- [Push (coming soon)](#user-content-push-coming-soon)


## Features

TiMeteor adds following features to your Titanium app

* Full Meteor API Version 0.8.3 (except:"Template" and general browser and server related namespaces)
* Local in-memory MongoDB API
* Realtime DB Sync with Latency Compensation
* Out of the box User System with the "accounts-password" meteor package
* Less callbacks: Synchronous Calls and Reactive Programming with Deps 
* Exchange login tokens between your native app and Ti.UI.WebView with the ti.meteor "WebView" plugin, so you can easily switch between native Views and HTML5 content. 
* completely cross-platform, works on iOS and Android exactly the same way
* working with Alloy or Classic apps

TiMeteor does NOT provide data persistence on the client right now, but it is considered to be implemented. If you have an idea how to do this in elegant way, feel free to contribute. 

## Module Dependencies

Because Meteor uses __WebSockets__ instead of HTTP Calls to communicate with its server we need to include the excellent crossplatform websocket module from [iamyellow](http://iamyellow.net/). Grab the modules on the Appcelerator Marketplace ([Android Version](https://marketplace.appcelerator.com/apps/3158#!overview), [iOS Version](https://marketplace.appcelerator.com/apps/2825#!overview)) or checkout and compile them from the [Github Repo](https://github.com/iamyellow/tiws)

* to install the module drag the zip files into titanium __project__ folder.
* add this line to the __modules tag__ in your projects __tiapp.xml__ file 

```xml
<module>net.iamyellow.tiws</module>
```

## Installation

After installing the "tiws" module. Simply check out this repo or use Github's "Download Zip" button. Then extract the zip in the correct folder of your Project depending on the type of your Titanium app. The "ti.meteor" folder must be one of these directories, depending on the type of Titanium app. 

###Alloy

YourProjectName/app/lib/

create the lib folder if it doesn't exist

###Classic

YourProjectName/Resources/

 
## Usage

### Initialization Code

When you are using __Alloy__ the following lines must be put in the __alloy.js__ file.

In a __Classic__ Project put these lines into the __app.js__ file.

```javascript

var TiMeteor = require('ti.meteor/meteor');
_ = TiMeteor._;

Meteor = TiMeteor.Meteor;
Package = TiMeteor.Package;
Deps = TiMeteor.Deps;
Session = TiMeteor.Session;
Accounts = TiMeteor.Accounts;

// add ti.meteor specific plugins

TiMeteor.WebView = require('ti.meteor/plugins/webview');

// initialize Meteor and connect to your server
TiMeteor.init({
	host: "localhost",
	port: 3000,
	use_ssl: false
});
```

### Basic Example

This is a basic example how to use TiMeteor, a showcase demo alloy app and video tutorials will follow soon. 


#### Server

Install Meteor

```
curl https://install.meteor.com | /bin/sh
```
create a folder and meteor project
```bash
mkdir meteor
cd meteor
meteor create ti-meteor-example
cd ti-meteor-example
meteor add accounts-password
meteor
```
Now create a Collection in the ti-meteor-example.js 

```

Projects = new Meteor.Collection("projects");

if (Meteor.isServer) {
	
    Meteor.startup(function() {
    
    	var projectTitles = ["one", "two", "three"];
        if (Projects.find().count() == 0) {
        	_.each(projectTitles, function(title) {
        		Projects.insert({title:"Project "+title});
        	});
		}
    
    });

    Meteor.methods({
		hello: function(name) {
			if (name) {
				return "hello "+name;
			}
		}
    });
}
```
#### Titanium

Create a Alloy or Clasic Project

Copy the __Initilization Code__ to the top of YourProjectName/app/alloy.js or YourProjectName/Resources/app.js 

Declare the "Projects" Collection in index.js or if you like to use it globally in alloy.js/app.js

```javascript
Projects = new Meteor.Collection("projects");
```
Subscribe to that collection in a reactive way and make a database call every time our Meteor.subscribe() call or our mongo query changes the callback function will be executed again. 

You can simply update your UI elements that way.

```javascript
var dep = Deps.autorun(function() {
	var projects = Projects.find().fetch();
	console.log("projects: "+JSON.stringify(projects));
	return Meteor.subscribe("projects");
});
```
A typical pattern would be to stop the dependency observing and subscriptions when your window or controller is closed or destroyed
```javascript
$.myWindow.addEventListener('close', function() {
	dep.stop(;
});
```

Call our Meteor method "hello"

```javascript
Meteor.call("hello", "world", function(error, data) {
	Ti.API.info("data: "+data);
});
```

## Documentation

### TiMeteor API

"ti.meteor/meteor.js" is basically just a helper script to setup the global Meteor related namespaces and correctly resolve package dependencies. This part of TiMeteor might be changed in the future, either the complete project will be shipped as a single file commonjs module, or integrated with the new meteor package system coming in the Meteor 0.9.0. 

#### Methods

__TiMeteor.init(options):null__

init() must be called after the full Meteor is already initialized as global variables

the options are:
```javascript
var options = {
	host: String // "localhost" or "192.168.0.100" or "somedomain.com"
	port: Number // 3000 
	use_ssl: Boolean // set this to true if you are using ssl on the server
};
```

### Meteor API

See [http://docs.meteor.com](http://docs.meteor.com) for the Meteor API, every client related command should work. 

The only thing which is missing right now ist the Login with external Service Feature which allows you to login into your Meteor user system with google, facebook, etc accounts. But the "accounts-password" package is completly working. 

## Plugins

TiMeteor can be easily extended through plugins. Plugins are simple commonjs modules, which depend on the Meteor API. 

Plugins don't have to be defined globally like the basic TiMeteor framework, but it is convenient to also assign them to the global "TiMeteor" namespace.


### WebView

The WebView plugin helps you to seeminglessly switch between native Titanium Views and HTML5 Content of your Meteor web app by importing, exporting or removing the Meteor Login Token from a WebView.

Usage:
```javascript
TiMeteor.WebView = require('ti.meteor/plugins/webview');
```

#### Methods

__TiMeteor.WebView.importToken(Ti.UI.WebView) : null__

importToken() imports the Token from a logged in User to the localstorage of a webview and reloas the page, to make sure the user is logged in.

Example:

```javascript
var injected = false;
$.webView.addEventListener("load", function() {
	if (!injected) {
		TiMeteor.WebView.importToken($.webView);
		injected = true;
	}
});
```
__TiMeteor.WebView.exportToken(Ti.UI.WebView) : Object__

exportToken() exports the Meteor Token from the Localstorage of a WebView returns a dictionary with the userId, token and token expire date

__TiMeteor.WebView.removeToken(Ti.UI.WebView) : null__

removeToken() removes the Meteor Tokens from a WebView, so the user will be logged out

### Push (coming soon)

The Push plugin will consist of Meteor package for the server and a TiMeteor client plugin. 

Goals of this plugin:

* normalize the Push API on client and server for iOS and Android
* Automatic deviceToken managment in the user accounts system
* manage server connection state depending app pause & resume
* Manage Push Notification Delivery









