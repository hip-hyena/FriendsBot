# @FriendsBot

This is a sample bot for Telegram, made as an entry for [Telegram 2023 Mini App Contest](https://t.me/contest/327).

You can engage directly with the functioning bot [@FriendsBot](https://t.me/FriendsBot), or clone and modify this repository to fit your personal needs (see the [Deployment](#Deployment) section). This option can be particularly appealing to privacy-conscious individuals who desire full control over their data storage and usage. Given the bot's access to sensitive information such as user locations, this ensures adherence to strict privacy measures.

## Known issues

Unfortunately, Telegram does not provide (yet) a reliable way to prevent vertical swipe gestures from "leaking" to the Telegram client. This means that some touch gestures can be interpreted incorrectly and lead to expanding/closing Mini App instead of interacting with its elements. This is especially noticable on Android devices.

## Usage

This bot is designed to fulfill a simple objective — it helps you track your friends' whereabouts globally at a city level. No more, no less.

Start by activating the bot; it will provide the link: `https://t.me/FriendsBot/map`. By sending the link in any Telegram chat or channel, be it a private chat with your friends or a public community channel, members can view the locations of **only their fellow participants in the same chat/channel** given they have shared their locations. To do so, you must proactively give access your location within each group.

To update your location, enter your city's name and hit the "Save" button. Alternatively, you can use the geolocation button located on the screen's right side. By default, this action will place your marker **in the city center**, not an exact location, to safeguard your privacy. However, you have the option to drag the marker to a more precise point before saving. We generally recommend against it for safety measures.

You may also choose to follow specific individuals by tapping on their markers and pressing the "Follow" button. They will receive a notification and given options to either follow you back or block you. You can review all your followed individuals by clicking the "Map" button in a private chat with the bot, unveiling your personal location map.

The bot does not autonomously update locations. If you relocate to a different city, you will need to update this manually. To help jog forgetful minds, we incorporated a *ping* option — simply tap on a marker and select "Ping". This prompts a kind notification asking users to ensure their location is current.

## Privacy

This bot takes some measures to keep sensitive information to a minimum:

1. **Locations are never requested passively**. Even when you press a button to detect your location, it first displays a temporary marker which can moved elsewhere before pressing "Save" (this also means that there's nothing preventing people from lying about their actual location — you either believe your friends or not).
2. **Automatic geolocation is rounded to the nearest city on client-side**. If you decide to allow automatically geolocate you (using a GPS sensor in your phone), the exact coordinates are never sent from your device. Instead, the closest city is selected directly on your phone, and a marker is placed at its center (and, again, you need to explicitly allow saving this position).
3. **City search is implemented without access to third-party services**. When you're searching for a specific city, this bot only uses its only database of cities, not some external service for geocoding (as its often done).
4. **Any coordinates are stored with 1km precision**. Before saving any position to the database (even a custom-positioned one) it's first rounded to 1x1km grid. Yes, this probably means that you won't be able to place a marker directly on your house: that's not what this service is for. 

## Deployment

The process of cloning this bot/app is rather straightforward. It's written in Node.js using Express framework and all data is stored in SQLite. This means that deployment does not require installation and configuration of an external database (but the source code can be modified to use it, of course).

First, make sure you have the latest version of [Node](https://nodejs.org/en) installed. It's also recommended to have [Git](https://git-scm.com/downloads) installed (to clone this repository). To keep the server running you can install [PM2](https://pm2.keymetrics.io/), for example. You can also use [Nginx](https://nginx.org/en/download.html) as a reverse proxy in front of this app.

Clone this repository into any directory:
```
git clone https://github.com/hip-hyena/FriendsBot.git
```
(or, if you don't use Git, just download this repo as a ZIP file and unpack it in any directory)

Go to directory where you cloned the repository and install dependencies:
```
cd FriendsBot
npm install
```

Now you need to configure your version of this app.

Visit [BotFather](https://t.me/BotFather) and create your bot. You can choose any name/username/description. It's recommended to configure a custom menu button for your bot: select "`Bot Settings`" - "`Menu button`". For url, enter "`https://<YOUR_HOSTNAME>/#type=menu`". Also type `/newapp` and create a Mini App associated with the bot you've just created. Similarly, use "`https://<YOUR_HOSTNAME>/`" as an URL for your app. If you use Nginx, you can use the public path you've configured as `<YOUR_HOSTNAME>`.

Now create a text file named `.env` in the root directory of this repository. It should have the following contents:
```
TELEGRAM_USERNAME=<BOT_USERNAME>
TELEGRAM_TOKEN="<BOT_TOKEN>"
MINIAPP_HOST=<PUBLIC_URL>
MINIAPP_PORT=<INTERNAL_PORT>
```

Replace placeholders in angle brackets with the appropriate values and this file (enter `<BOT_USERNAME>` without an @-sign).

Finally, for client maps this app uses [Mapbox](https://www.mapbox.com/). If you don't expect a lot of traffic, the free version should be more than enough. Sign up, create an access token (with the default public scopes) and a map style (you can clone one of [the publicly available ones](https://www.mapbox.com/gallery/)).

Open file `static/js/main.js` in this repository and update first two lines (with constants names `MAPBOX_TOKEN` and `MAPBOX_STYLE`) with values you've create at Mapbox.

That's all for configuration. Now you can run the server:
```
node server.js
```

Or, if you're using `PM2`, you can add this app to the list of continuously running scripts:
```
pm2 start --name YourBotName server.js
pm2 save
```

If you're using `Nginx`, don't forget to make sure you've configured it to correctly proxy requests from `<PUBLIC_URL>` to `localhost:<INTERNAL_PORT>`. You also may need to configure [Certbot](https://certbot.eff.org/) to acquire HTTPS certificates (you can follow [this tutorial](https://www.digitalocean.com/community/tutorials/how-to-secure-nginx-with-let-s-encrypt-on-ubuntu-20-04) for details).

## Rebuilding Geonames database

This project uses data from [Geonames](http://www.geonames.org/) to provide localised city search. This data is stored in `geonames.sqlite3` database and already included in this repository. You may, however, want to rebuild it at later time. To do that:

1. Delete `geonames.sqlite3`
2. Run `node import-geonames.js`

This will create directory called `dumps` for temporary storage of Geonames dumps (about 170 MB). You can delete that directory after the process finishes (it should only take a couple of minutes).