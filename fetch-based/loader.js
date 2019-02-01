(function () {
    if (window.define || window._defined) {
        return;
    }
    window._defined = {};

    const
        getBaseUrl = () => (document.baseURI || (document.querySelector('base') || window.location).href);


    window.define = function (deps, resolve) {

    }

})();