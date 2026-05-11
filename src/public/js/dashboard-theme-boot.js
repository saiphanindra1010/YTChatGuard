(function () {
  var allowed =
    'autumn,business,acid,lemonade,night,coffee,winter,dim,nord,sunset'.split(',');
  try {
    var raw =
      localStorage.getItem('safestream-theme') ||
      localStorage.getItem('ytchatguard-theme') ||
      'autumn';
    var t = allowed.indexOf(raw) >= 0 ? raw : 'autumn';
    document.documentElement.setAttribute('data-theme', t);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'autumn');
  }
})();
