'use strict';
let name = new URLSearchParams(location.search).get('name') || 'Another device';
if (name.length > 24) name = name.slice(0, 23) + '…';
document.getElementById('name').textContent = name;
