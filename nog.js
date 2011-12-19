var Path = require('path');
var JsonDB = require('jsondb');
var Corn = require('corn');
var Stack = require('stack');
var FS = require('fs');
var Markdown = require('markdown');
var Creationix = require('creationix');

module.exports = function setup(path, options) {
  options = options || {};
  var templateDir = options.templateDir || Path.join(path, "templates");
  var resourceDir = options.resourceDir || Path.join(path, "resources");
  var db = JsonDB(path, ".markdown");

  var templateCache = {};
  var readBatch = {};
  
  Corn.helpers = {
    render: render,
    query: query,
  };



  return Stack.compose(
    Creationix.static("/", resourceDir),
    Creationix.route("GET", "/", function (req, res, params, next) {
      render("frontindex", {
        title: query("index", "title"),
        links: query("index", "links"),
        articles: loadArticles
      }, function (err, html) {
        if (err) return next(err);
        res.writeHead(200, {
          "Content-Length": Buffer.byteLength(html),
          "Content-Type": "text/html; charset=utf-8"
        });
        res.end(html);
      });
    }),
    Creationix.route("GET",  "/:article", function (req, res, params, next) {
      loadArticle(params.article, function (err, article) {
        if (err) {
          if (err.code === "ENOENT") return next();
          return next(err);
        }
        render("articleindex", {
          title: query("index", "title"),
          links: query("index", "links"),
          article: article
        }, function (err, html) {
          if (err) return next(err);
          res.writeHead(200, {
            "Content-Length": Buffer.byteLength(html),
            "Content-Type": "text/html; charset=utf-8"
          });
          res.end(html);
        });
      });
    })
  );

  function loadArticle(name, callback) {
    query("articles/" + name, function (err, article) {
      if (err) return callback(err);
      article.id = name;
      article.body = Markdown.parse(article.attachment);
      query("authors/" + article.author, function (err, author) {
        if (err) return callback(err);
        author.id = article.author;
        article.author = author;
        callback(null, article);
      });
    });
  }

  function loadArticles(callback) {
    query("index", "articles", function (err, list) {
      if (err) return callback(err);
      var articles = new Array(list.length);
      var left = articles.length;
      list.forEach(function (name, i) {
        loadArticle(name, function (err, article) {
          if (err) return callback(err);
          articles[i] = article;
          left--;
          if (left === 0) {
            callback(null, articles);
          }
        });
      });
    });
  }

  // Query a field from the database
  function query(file, path, callback) {
    if (typeof path === "function" && callback === undefined) {
      callback = path;
      path = [];
    }
    if (!callback) {
      return function (callback) {
        query(file, path, callback);
      }
    }
    if (typeof path === 'string') path = path.split('.');
    db.get(file, function (err, data) {
      if (err) return callback(err);
      for (var i = 0, l = path.length; i < l; i++) {
        var part = path[i];
        if (!data.hasOwnProperty(part)) {
          return callback(new Error("Bad path " + part));
        }
        data = data[path[i]];
      }
      callback(null, data);
    });
  }


  // Main entry point for data rendering
  function render(name, data, callback) {
    // Allow lazy data
    if (typeof data === "function") return data(function (err, data) {
      if (err) return callback(err);
      render(name, data, callback);
    });
    // Allow looping over data
    if (Array.isArray(data)) return renderArray(name, data, callback);

    // Compile and render a template
    data.__proto__ = Corn.helpers;
    compile(name, function (err, template) {
      if (err) return callback(err);
      template(data, callback);
    });
  }

  function renderArray(name, array, callback) {
    if (array.length === 0) return callback(null, "");
    var left = array.length;
    var parts = [];
    array.forEach(function (data, i) {
      render(name, data, function (err, html) {
        if (err) return callback(err);
        parts[i] = html;
        left--;
        if (left === 0) {
          callback(null, parts.join(""));
        }
      });
    });
  }

  // A caching and batching template loader and compiler
  function compile(name, callback) {
    if (templateCache.hasOwnProperty(name)) {
      var template = templateCache[name];
      process.nextTick(function () {
        callback(null, template);
      });
      return;
    }
    if (readBatch.hasOwnProperty(name)) {
      readBatch[name].push(callback);
      return;
    }
    readBatch[name] = [callback];
    realCompile(name, function (err, template) {
      if (!err) {
        templateCache[name] = template;
        setTimeout(function () {
          delete templateCache[name];
        }, 1000);
      }
      var batch = readBatch[name];
      delete readBatch[name];
      for (var i = 0, l = batch.length; i < l; i++) {
        batch[i](err, template);
      }
    });
  }

  function realCompile(name, callback) {
    FS.readFile(Path.join(templateDir, name + ".html"), "utf8", function (err, source) {
      if (err) return callback(err);
      try {
        var template = Corn(source);
      } catch (err) {
        return callback(err);
      }
      callback(null, template);
    });
  }

};