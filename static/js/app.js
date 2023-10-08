const MAPBOX_TOKEN = '<YOUR_TOKEN>';
const MAPBOX_STYLE = '<YOUR_STYLE>';

//const UserColors = ['#e17076', '#7bc862', '#65aadd', '#a695e7', '#ee7aae', '#6ec9cb', '#faa774'];
const UserColors = ['#eb4b54cc', '#4db02dcc', '#2c81c0cc', '#8264f2cc', '#ea5296cc', '#29b2b5cc', '#fb9553cc'];

async function api(endpoint, params = {}) {
  return (await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(Object.assign({
      initData: Telegram.WebApp.initData,
    }, params)),
  })).json();
}

function deg2rad(deg) {
  return deg * (Math.PI/180)
}

function getDistance(lat1, lon1, lat2, lon2) {
  var R = 6371;
  var dLat = deg2rad(lat2-lat1);
  var dLon = deg2rad(lon2-lon1); 
  var a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) * 
    Math.sin(dLon/2) * Math.sin(dLon/2); 
  var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function findClosestCity(longitude, latitude) {
  if (!citiesCoords) {
    return null;
  }
  let minLat, minLng, minIdx, r;
  let minDist = Infinity;
  for (let i = 0; i < citiesCoords.length; i += 5) {
    const lat = (citiesCoords[i] | (citiesCoords[i + 1] << 8)) * 180 / 65535 - 90;
    const lng = (citiesCoords[i + 2] | (citiesCoords[i + 3] << 8)) * 360 / 65535 - 180;
    const radius = (citiesCoords[i + 4] / 10) + 0.1;
    const dist = getDistance(lat, lng, latitude, longitude) / radius;
    if (dist < minDist) {
      minDist = dist;
      minLat = lat;
      minLng = lng;
      minIdx = i / 5;
      r = radius;
    }
  }
  //console.log('Closest city is at #' + minIdx, fullCities[minIdx].split('\t'));
  console.log('radius=',r);
  return { latitude: minLat, longitude: minLng, index: minIdx };
}

function showNotification(msg, withArrow) {
  const notificationEl = document.getElementById('notification');
  notificationEl.innerHTML = msg;
  notificationEl.classList.remove('is-hidden');
  notificationEl.classList.toggle('is-with-arrow', !!withArrow);
  setTimeout(() => {
    notificationEl.classList.add('is-hidden');
  }, 8000);
}

async function hide() {
  users[me.id].marker.remove();
  delete users[me.id];
  delete markersOnScreen[`user:${me.id}`];
  Telegram.WebApp.MainButton.hide();
  updateSource();
  await api('hide');
}

function updateMerged(mergeId) {
  const merged = [];
  for (let id in users) {
    if (users[id].mergeId == mergeId) {
      merged.push(id);
    }
  }
  // Users with longer names will be shown in front (it will make stacks look tidier)
  merged.sort((id1, id2) => users[id2].name.length - users[id1].name.length); 
  for (let i = 0; i < merged.length; i++) {
    const id = merged[i];
    users[id].isStacked = i > 0;
    users[id].stackDepth = i;
    users[id].merged = merged;
    users[id].el.classList.toggle('is-stacked', i > 0);
    users[id].el.style.setProperty('--depth', i);
  }
}

function createClusterMarker(id, coords, count) {
  const el = document.createElement('div');
  el.className = 'user-cluster';
  el.innerText = count;
  el.addEventListener('click', () => {
    map.getSource('users').getClusterExpansionZoom(id, (err, zoom) => {
      if (err) return;
       
      map.easeTo({
        center: coords,
        zoom: zoom * 1.1,
      });
    });
  });
  return new mapboxgl.Marker(el);
}

function updateUser(id, username, name, countryCode, countryName, location, mergeId, lng, lat, isFollowed, isPingable, isDraggable) {
  if (isNaN(lng) || isNaN(lat)) {
    return; // Invalid coords
  }

  if (isDraggable) {
    mergeId = 'temp';
  }

  if (!(id in users)) {
    const el = document.createElement('div');
    const contentEl = document.createElement('div');
    contentEl.className = 'user-marker__content';
    const nameEl = document.createElement('div');
    nameEl.className = 'user-marker__name';
    contentEl.appendChild(nameEl);
    const locationEl = document.createElement('div');
    locationEl.className = 'user-marker__location';
    contentEl.appendChild(locationEl);
    contentEl.addEventListener('click', (ev) => {
      //Telegram.WebApp.openTelegramLink(`https://t.me/${username}`);
      if (selectedEl) {
        selectedEl.classList.remove('is-selected');
      }
      if (dragged) {
        return;
      }
      selectedEl = el;
      map.flyTo({
        center: [users[id].longitude, users[id].latitude],
        padding: { top: 0, bottom: 0, left: 0, right: 100 }
      });
      el.classList.add('is-selected');
      ev.stopPropagation();
    });
    contentEl.style.cursor = 'pointer';
    el.appendChild(contentEl);
    const buttonsEl = document.createElement('div');
    buttonsEl.className = 'user-marker__buttons';
    if (me.id == id) {
      const thisIsYouEl = document.createElement('span');
      thisIsYouEl.innerText = 'This Is You';
      buttonsEl.appendChild(thisIsYouEl);

      const editBtn = document.createElement('button');
      editBtn.className = 'user-marker__edit-btn';
      editBtn.innerText = 'Edit Position';
      editBtn.addEventListener('click', async (ev) => {
        if (selectedEl) {
          selectedEl.classList.remove('is-selected');
        }
        ev.stopPropagation();
        updateUser(id, username, name, '', '', '', '', users[id].longitude, users[id].latitude, false, false, true);
        
        Telegram.WebApp.MainButton.show();
        Telegram.WebApp.MainButton.text = 'Save Position';
      });
      buttonsEl.appendChild(editBtn);

      const hideBtn = document.createElement('button');
      hideBtn.innerText = 'Hide Me';
      hideBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        await hide();
      });
      buttonsEl.appendChild(hideBtn);
    } else {
      const followBtn = document.createElement('button');
      followBtn.innerText = isFollowed ? 'Unfollow' : 'Follow';
      followBtn.addEventListener('click', async (ev) => {
        if (selectedEl) {
          selectedEl.classList.remove('is-selected');
        }
        ev.stopPropagation();
        
        const res = await api('follow', { id, follow: !users[id].isFollowed });
        if (!res.error) {
          if (appType == 'menu' && users[id].isFollowed) {
            users[id].marker.remove();
            delete users[id];
            updateSource();
            return;
          }
          users[id].isFollowed = !users[id].isFollowed;
          followBtn.innerText = users[id].isFollowed ? 'Unfollow' : 'Follow';

          showNotification(users[id].isFollowed ? `<p>You are now following <b>${name}</b>.</p><p>This means that you will see them on your personal map (available in the private chat with this bot).</p>` : `You stopped following <b>${name}</b>`);
        } else
        if (res.blocked) {
          Telegram.WebApp.showAlert('Unfortunately, this user restricted you from following them.');
        }
      });
      buttonsEl.appendChild(followBtn);

      if (isPingable) {
        const pingBtn = document.createElement('button');
        pingBtn.innerText = 'Send Ping';
        pingBtn.addEventListener('click', async (ev) => {
          if (selectedEl) {
            selectedEl.classList.remove('is-selected');
          }
          ev.stopPropagation();

          const res = await api('ping', { id });
          const notificationEl = document.getElementById('notification');
          notificationEl.innerHTML = `<p>You've pinged <b>${name}</b>.</p><p>That should remind them to keep their location up-to-date!</p>`;
          notificationEl.classList.remove('is-hidden');
          setTimeout(() => {
            notificationEl.classList.add('is-hidden');
          }, 8000);
        });
        buttonsEl.appendChild(pingBtn);
      }

      if (username) {
        const profileBtn = document.createElement('button');
        profileBtn.innerText = 'Open Profile';
        profileBtn.addEventListener('click', () => {
          Telegram.WebApp.openTelegramLink(`https://t.me/${username}`);
        });
        buttonsEl.appendChild(profileBtn);
      }
    }
    contentEl.appendChild(buttonsEl);
    const iconEl = document.createElement('div');
    iconEl.className = 'user-marker__icon';
    iconEl.innerText = name[0] + (name.indexOf(' ') > -1 ? name[name.indexOf(' ') + 1] : '');
    iconEl.addEventListener('click', () => {
      map.flyTo({
        center: [users[id].longitude, users[id].latitude],
        zoom: Math.max(map.getZoom(), 3.5),
        padding: { top: 0, bottom: 0, left: 0, right: 100 }
      });
    });
    el.appendChild(iconEl);
    el.className = 'user-marker';
    el.style.setProperty('--background-color', UserColors[id % UserColors.length]);
    const marker = new mapboxgl.Marker(el).setLngLat([lng, lat]);
    marker.on('dragstart', () => {
      if (selectedEl) {
        selectedEl.classList.remove('is-selected');
      }
    });
    marker.on('drag', () => {
      dragged = id;
    });
    marker.on('dragend', () => {
      const lngLat = marker.getLngLat();
      users[id].latitude = lngLat.lat;
      users[id].longitude = lngLat.lng;
      updateSource();
      //findClosestCity(lngLat.lng, lngLat.lat);
      setTimeout(() => dragged = false, 0);
    });
    users[id] = {
      mergeId, latitude: lat, longitude: lng, name, location, isFollowed,
      el, contentEl, nameEl, locationEl,
      marker,
    }
  } else {
    if (users[id].mergeId != mergeId) {
      // Changing mergeId will potentially un-group markers
      const oldMergeId = users[id].mergeId;
      users[id].mergeId = mergeId;
      updateMerged(oldMergeId);
    }
  }

  users[id].latitude = lat;
  users[id].longitude = lng;
  users[id].name = name;
  users[id].location = location;
  users[id].mergeId = mergeId;
  updateMerged(mergeId);
  users[id].nameEl.innerText = name;
  users[id].isDraggable = isDraggable;
  if (isDraggable) {
    users[id].locationEl.innerText = 'Drag & Hit Save';
  } else {
    users[id].locationEl.innerHTML = (countryCode ? `<img src="flags/16x12/${countryCode}.png" srcset="flags/32x24/${countryCode}.png 2x, flags/48x36/${countryCode}.png 3x" width="16" height="12" alt="${countryName}">` : '') + location;
  }
  users[id].el.classList.toggle('is-draggable', isDraggable);
  users[id].marker.setLngLat([lng, lat]);
  users[id].marker.setDraggable(isDraggable);
}

function setPosition(pos, country_code = '', country_name = '', name = '') {
  updateUser(
    me.id, me.username,
    me.first_name + (me.last_name ? ' ' + me.last_name : ''),
    //country_code, country_name, name,
    '', '', '',
    `lonlat:${pos.longitude.toFixed(4)}:${pos.latitude.toFixed(4)}`,
    pos.longitude, pos.latitude,
    false, false, true,
  );
  updateSource();
  Telegram.WebApp.MainButton.show();
  Telegram.WebApp.MainButton.text = 'Save Position';
}

function updateSource(skipUpdateMarkers) {
  const data = {
    type: 'FeatureCollection',
    features: Object.keys(users).filter(id => !users[id].isStacked && !users[id].isDraggable).map(id => {
      const user = users[id];
      return {
        type: 'Feature',
        geometry: {
          type: 'Point',
          coordinates: [user.longitude, user.latitude],
        },
        properties: {
          id, count: users[id].merged ? users[id].merged.length : 1,
        },
      }
    })
  };

  const source = map.getSource('users');
  if (source) {
    source.setData(data);
  } else {
    map.addSource('users', {
      type: 'geojson', data,
      cluster: true, clusterRadius: 40, clusterMaxZoom: 8, clusterProperties: {
        count: ['+', ['get', 'count']],
      }
    });
  }
  if (layerAdded && !skipUpdateMarkers) {
    updateMarkers();
  }
}

function updateMarkers() {
  document.getElementById('map').classList.toggle('is-compact', map.getZoom() < 3);

  const newMarkers = {};
  const features = map.querySourceFeatures('users');
  for (const feature of features) {
    const coords = feature.geometry.coordinates;
    const props = feature.properties;
    const id = props.cluster ? `cluster:${props.cluster_id}` : `user:${props.id}`;
    if (!props.cluster && !(props.id in users)) {
      continue;
    }
     
    let marker = markers[id];
    if (!marker) {
      marker = props.cluster ? createClusterMarker(props.cluster_id, coords, props.count) : users[props.id].marker;
      markers[id] = marker;
    }
    //if (props.cluster) {
      marker.setLngLat(coords);
    //}
    newMarkers[id] = marker;
     
    if (!markersOnScreen[id]) marker.addTo(map);

    // If we merged other markers into this one, we need to add them as well
    if (!props.cluster && !users[props.id].isStacked && users[props.id].merged && users[props.id].merged.length > 1) {
      for (let userId of users[props.id].merged) {
        if (userId == props.id || !(userId in users)) {
          continue;
        }

        const id = `user:${userId}`;
        let marker = markers[id];
        if (!marker) {
          marker = users[userId].marker;
          markers[userId] = marker;
        }
        marker.setLngLat(coords);
        newMarkers[id] = marker;
        
        if (!markersOnScreen[id]) marker.addTo(map);
      }
    }
  }

  if (me.id in users && users[me.id].isDraggable) { // Always display draggable marker separately
    const id = `user:${me.id}`;
    let marker = markers[id];
    if (!marker) {
      marker = users[me.id].marker;
      markers[id] = marker;
    }
    marker.setLngLat([users[me.id].longitude, users[me.id].latitude]);
    newMarkers[id] = marker;
    if (!markersOnScreen[id]) marker.addTo(map);
  }

  for (const id in markersOnScreen) {
    if (!newMarkers[id]) markersOnScreen[id].remove();
  }
  markersOnScreen = newMarkers;
}

async function loadCities() {
  const buf = await (await fetch('cities-coords.bin')).arrayBuffer();
  citiesCoords = new Uint8Array(buf);
}

async function init() {
  const res = await api('users', { type: appType });

  finishInit = () => {
    for (let userId in res.users) {
      const user = res.users[userId];
      let location = '???';
      if (user.city_id && res.cities[user.city_id]) {
        location = res.cities[user.city_id];
      } else
      if (user.region_id && res.regions[user.region_id]) {
        location = res.regions[user.region_id];
      } else
      if (user.country_code && res.countries[user.country_code]) {
        location = res.countries[user.country_code];
      }

      updateUser(
        userId, user.username, user.first_name + (user.last_name ? ' ' + user.last_name : ''),
        user.country_code, res.countries[user.country_code] || '', location,
        `lonlat:${user.longitude.toFixed(4)}:${user.latitude.toFixed(4)}`,
        user.longitude, user.latitude,
        user.is_followed, user.is_pingable, false,
      );
    }

    const bounds = new mapboxgl.LngLatBounds();
    if (Object.keys(users).length) {
      for (let id in users) {
        bounds.extend([users[id].longitude, users[id].latitude]);
      }
      const cam = map.cameraForBounds(bounds, {
        maxZoom: 9,
        //padding: { top: 50, bottom: 50, left: 50, right: 50 }
      });
      map.flyTo(Object.assign(cam, {
        zoom: cam.zoom * 0.7,
      }));
    }

    updateSource();

    if (!(me.id in users)) {
      showNotification('Enter your city name and press "Save" to show you on this map.', true);
    }
  }

  if (map.loaded()) {
    finishInit();
    finishInit = null;
  }
}

function debounce(func, timeout = 300) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => { func.apply(this, args); }, timeout);
  };
}

let prevSearch = '';
const search = debounce(async () => {
  const q = document.getElementById('search').value;
  const searchResultsEl = document.getElementById('search-results');
  const results = await api('geocode', { q });
  if (document.getElementById('search').value != q || q == prevSearch) {
    return;
  }
  if (!results.cities.length) {
    searchResultsEl.classList.add('is-hidden');
    return;
  }
  prevSearch = q;
  searchResultsEl.classList.remove('is-hidden');
  searchResultsEl.innerHTML = '';
  for (let city of results.cities) {
    const cityEl = document.createElement('div');
    const nameEl = document.createElement('div');
    const regionEl = document.createElement('div');
    cityEl.className = 'city';
    
    nameEl.className = 'city__name';
    nameEl.innerText = city.name;

    const countryCode = city.country_code;
    const countryName = results.countryNames[countryCode];
    const regionName = results.regionNames[city.region_id];
    regionEl.className = 'city__region';
    regionEl.innerHTML = `<img src="flags/16x12/${countryCode}.png" srcset="flags/32x24/${countryCode}.png 2x, flags/48x36/${countryCode}.png 3x" width="16" height="12" alt="${countryName}"> ${countryName}${regionName && (regionName != city.name) ? ', ' + regionName : ''}`;
    cityEl.appendChild(nameEl);
    cityEl.appendChild(regionEl);
    cityEl.addEventListener('click', () => {
      if (document.activeElement) {
        document.activeElement.blur();
      }
      document.getElementById('search').value = '';
      searchResultsEl.classList.add('is-hidden');
      setPosition({ longitude: city.longitude, latitude: city.latitude }, countryCode, countryName, city.name);
      map.flyTo({
        zoom: 9,
        center: [city.longitude, city.latitude],
        padding: { top: 0, bottom: 0, left: 0, right: 100 }
      });
    });
    searchResultsEl.appendChild(cityEl);
  }
  searchResultsEl.scrollTop = 0;
});

async function onSearchInput() {
  const q = document.getElementById('search').value;
  const searchResultsEl = document.getElementById('search-results');
  if (q.length < 2) {
    searchResultsEl.classList.add('is-hidden');
    return;
  }
  search();
}

mapboxgl.accessToken = MAPBOX_TOKEN;
const me = Telegram.WebApp.initDataUnsafe && Telegram.WebApp.initDataUnsafe.user || {};
const users = {};
const markers = {};
let markersOnScreen = {};
let finishInit = null;
let layerAdded = false;
let selectedEl = null;
let citiesCoords = null;
let dragged = false;
const alreadyExpanded = Telegram.WebApp.isExpanded;
const appType = Telegram.WebView.initParams.type || 'link';
Telegram.WebApp.MainButton.onClick(async () => {
  Telegram.WebApp.MainButton.showProgress();

  const closest = findClosestCity(users[me.id].longitude, users[me.id].latitude);
  const { latitude, longitude, country_code, location } = await api('save', { longitude: users[me.id].longitude, latitude: users[me.id].latitude, idx: closest.index });

  /*map.flyTo({
    zoom: 9,
    center: [result.longitude, result.latitude],
    padding: { top: 0, bottom: 0, left: 0, right: 100 }
  });*/

  updateUser(
    me.id, me.username,
    me.first_name + (me.last_name ? ' ' + me.last_name : ''),
    country_code, '', location,
    `lonlat:${longitude.toFixed(4)}:${latitude.toFixed(4)}`,
    longitude, latitude,
    false, false, false,
  );
  updateSource(true);
  Telegram.WebApp.MainButton.hideProgress();
  Telegram.WebApp.MainButton.hide();

  /*navigator.geolocation.getCurrentPosition(async (pos) => {
   
  }, (err) => {
    Telegram.WebApp.showAlert(`Unable to get your current location (error ${err.code}: ${err.message}). Try again or select "Enter City Manually..." using the dropdown.`);
  });*/
});

if (!alreadyExpanded) {
  document.getElementById('app').style.height = `${Telegram.WebApp.viewportHeight}px`; // Send button should eat away 58px
}
Telegram.WebApp.onEvent('viewportChanged', () => {
  if (!alreadyExpanded) {
    document.getElementById('app').style.height = `${Telegram.WebApp.viewportHeight}px`;
    map.resize();
  }
  document.documentElement.scrollTop = 0;
});
Telegram.WebApp.ready();

window.addEventListener('click', () => {
  if (selectedEl) {
    selectedEl.classList.remove('is-selected');
    selectedEl = null;
  }
});
document.addEventListener('scroll', (e) => {
  //document.documentElement.scrollTop = 0;
});
const map = new mapboxgl.Map({
  container: 'map',
  style: MAPBOX_STYLE,
  language: me.language_code,
  center: [36.0, 40.0],
  zoom: 1,
  maxZoom: 12,
});
map.addControl(new mapboxgl.NavigationControl());
const geolocate = new mapboxgl.GeolocateControl({
  fitBoundsOptions: {
    maxZoom: 9,
  },
  positionOptions: {
    enableHighAccuracy: false
  },
  showUserLocation: false,
  trackUserLocation: false,
});
geolocate.on('geolocate', (pos) => {
  // Create marker if not exists, show both on map
  let closest = findClosestCity(pos.coords.longitude, pos.coords.latitude);
  if (closest) {
    setPosition({ latitude: closest.latitude, longitude: closest.longitude });
    return;
  }

  setPosition(pos.coords);
});
map.addControl(geolocate);
map.on('load', () => {
  if (finishInit) {
    finishInit();
  }
  map.addLayer({ /* This layer is not rendered, but otherwise source won't be processed */
    id: 'users_stub',
    type: 'circle',
    source: 'users',
    filter: false,
  });
  layerAdded = true;
  setTimeout(updateMarkers, 250);
});

/*
const script = document.getElementById('search-js');
script.onload = function() {
  const search = new MapboxSearchBox();
  search.options = {
    language: me.language_code,
    types: ['country', 'place'],
  };
  search.accessToken = MAPBOX_TOKEN;
  search.addEventListener('retrieve', (event) => {
    const feature = event.detail.features[0];
    if (!feature) {
      return;
    }
    const pos = feature.geometry.coordinates;
    const country = feature.properties.context && feature.properties.context.country || {};
    const name = feature.properties.name_preferred || feature.properties.name;
    setPosition({ longitude: pos[0], latitude: pos[1] }, country.country_code && country.country_code.toLowerCase(), country.name, name);
  });
  map.addControl(search, 'top-left');
};
*/

document.getElementById('app').addEventListener('touchmove', (ev) => {
  //ev.stopPropagation();
  ev.preventDefault();
  //return false;
}, { passive: false });
//map.setPadding({ top: 50, bottom: 50, left: 50, right: 50 });
map.on('moveend', updateMarkers);
let isZooming = false;
map.on('zoom', () => {
  isZooming = true;
  updateMarkers();
});
map.on('idle', () => {
  if (isZooming) {
    isZooming = false;
    updateMarkers();
  }
});
init();
loadCities();