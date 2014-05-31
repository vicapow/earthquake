!function() {
  var topojson = {
    version: "1.6.14",
    mesh: function(topology) { return object(topology, meshArcs.apply(this, arguments)); },
    meshArcs: meshArcs,
    merge: function(topology) { return object(topology, mergeArcs.apply(this, arguments)); },
    mergeArcs: mergeArcs,
    feature: featureOrCollection,
    neighbors: neighbors,
    presimplify: presimplify
  };

  function stitchArcs(topology, arcs) {
    var stitchedArcs = {},
        fragmentByStart = {},
        fragmentByEnd = {},
        fragments = [],
        emptyIndex = -1;

    // Stitch empty arcs first, since they may be subsumed by other arcs.
    arcs.forEach(function(i, j) {
      var arc = topology.arcs[i < 0 ? ~i : i], t;
      if (arc.length < 3 && !arc[1][0] && !arc[1][1]) {
        t = arcs[++emptyIndex], arcs[emptyIndex] = i, arcs[j] = t;
      }
    });

    arcs.forEach(function(i) {
      var e = ends(i),
          start = e[0],
          end = e[1],
          f, g;

      if (f = fragmentByEnd[start]) {
        delete fragmentByEnd[f.end];
        f.push(i);
        f.end = end;
        if (g = fragmentByStart[end]) {
          delete fragmentByStart[g.start];
          var fg = g === f ? f : f.concat(g);
          fragmentByStart[fg.start = f.start] = fragmentByEnd[fg.end = g.end] = fg;
        } else {
          fragmentByStart[f.start] = fragmentByEnd[f.end] = f;
        }
      } else if (f = fragmentByStart[end]) {
        delete fragmentByStart[f.start];
        f.unshift(i);
        f.start = start;
        if (g = fragmentByEnd[start]) {
          delete fragmentByEnd[g.end];
          var gf = g === f ? f : g.concat(f);
          fragmentByStart[gf.start = g.start] = fragmentByEnd[gf.end = f.end] = gf;
        } else {
          fragmentByStart[f.start] = fragmentByEnd[f.end] = f;
        }
      } else {
        f = [i];
        fragmentByStart[f.start = start] = fragmentByEnd[f.end = end] = f;
      }
    });

    function ends(i) {
      var arc = topology.arcs[i < 0 ? ~i : i], p0 = arc[0], p1;
      if (topology.transform) p1 = [0, 0], arc.forEach(function(dp) { p1[0] += dp[0], p1[1] += dp[1]; });
      else p1 = arc[arc.length - 1];
      return i < 0 ? [p1, p0] : [p0, p1];
    }

    function flush(fragmentByEnd, fragmentByStart) {
      for (var k in fragmentByEnd) {
        var f = fragmentByEnd[k];
        delete fragmentByStart[f.start];
        delete f.start;
        delete f.end;
        f.forEach(function(i) { stitchedArcs[i < 0 ? ~i : i] = 1; });
        fragments.push(f);
      }
    }

    flush(fragmentByEnd, fragmentByStart);
    flush(fragmentByStart, fragmentByEnd);
    arcs.forEach(function(i) { if (!stitchedArcs[i < 0 ? ~i : i]) fragments.push([i]); });

    return fragments;
  }

  function meshArcs(topology, o, filter) {
    var arcs = [];

    if (arguments.length > 1) {
      var geomsByArc = [],
          geom;

      function arc(i) {
        var j = i < 0 ? ~i : i;
        (geomsByArc[j] || (geomsByArc[j] = [])).push({i: i, g: geom});
      }

      function line(arcs) {
        arcs.forEach(arc);
      }

      function polygon(arcs) {
        arcs.forEach(line);
      }

      function geometry(o) {
        if (o.type === "GeometryCollection") o.geometries.forEach(geometry);
        else if (o.type in geometryType) geom = o, geometryType[o.type](o.arcs);
      }

      var geometryType = {
        LineString: line,
        MultiLineString: polygon,
        Polygon: polygon,
        MultiPolygon: function(arcs) { arcs.forEach(polygon); }
      };

      geometry(o);

      geomsByArc.forEach(arguments.length < 3
          ? function(geoms) { arcs.push(geoms[0].i); }
          : function(geoms) { if (filter(geoms[0].g, geoms[geoms.length - 1].g)) arcs.push(geoms[0].i); });
    } else {
      for (var i = 0, n = topology.arcs.length; i < n; ++i) arcs.push(i);
    }

    return {type: "MultiLineString", arcs: stitchArcs(topology, arcs)};
  }

  function mergeArcs(topology, objects) {
    var polygonsByArc = {},
        polygons = [],
        components = [];

    objects.forEach(function(o) {
      if (o.type === "Polygon") register(o.arcs);
      else if (o.type === "MultiPolygon") o.arcs.forEach(register);
    });

    function register(polygon) {
      polygon.forEach(function(ring) {
        ring.forEach(function(arc) {
          (polygonsByArc[arc = arc < 0 ? ~arc : arc] || (polygonsByArc[arc] = [])).push(polygon);
        });
      });
      polygons.push(polygon);
    }

    function exterior(ring) {
      return cartesianRingArea(object(topology, {type: "Polygon", arcs: [ring]}).coordinates[0]) > 0; // TODO allow spherical?
    }

    polygons.forEach(function(polygon) {
      if (!polygon._) {
        var component = [],
            neighbors = [polygon];
        polygon._ = 1;
        components.push(component);
        while (polygon = neighbors.pop()) {
          component.push(polygon);
          polygon.forEach(function(ring) {
            ring.forEach(function(arc) {
              polygonsByArc[arc < 0 ? ~arc : arc].forEach(function(polygon) {
                if (!polygon._) {
                  polygon._ = 1;
                  neighbors.push(polygon);
                }
              });
            });
          });
        }
      }
    });

    polygons.forEach(function(polygon) {
      delete polygon._;
    });

    return {
      type: "MultiPolygon",
      arcs: components.map(function(polygons) {
        var arcs = [];

        // Extract the exterior (unique) arcs.
        polygons.forEach(function(polygon) {
          polygon.forEach(function(ring) {
            ring.forEach(function(arc) {
              if (polygonsByArc[arc < 0 ? ~arc : arc].length < 2) {
                arcs.push(arc);
              }
            });
          });
        });

        // Stitch the arcs into one or more rings.
        arcs = stitchArcs(topology, arcs);

        // If more than one ring is returned,
        // at most one of these rings can be the exterior;
        // this exterior ring has the same winding order
        // as any exterior ring in the original polygons.
        if ((n = arcs.length) > 1) {
          var sgn = exterior(polygons[0][0]);
          for (var i = 0, t; i < n; ++i) {
            if (sgn === exterior(arcs[i])) {
              t = arcs[0], arcs[0] = arcs[i], arcs[i] = t;
              break;
            }
          }
        }

        return arcs;
      })
    };
  }

  function featureOrCollection(topology, o) {
    return o.type === "GeometryCollection" ? {
      type: "FeatureCollection",
      features: o.geometries.map(function(o) { return feature(topology, o); })
    } : feature(topology, o);
  }

  function feature(topology, o) {
    var f = {
      type: "Feature",
      id: o.id,
      properties: o.properties || {},
      geometry: object(topology, o)
    };
    if (o.id == null) delete f.id;
    return f;
  }

  function object(topology, o) {
    var absolute = transformAbsolute(topology.transform),
        arcs = topology.arcs;

    function arc(i, points) {
      if (points.length) points.pop();
      for (var a = arcs[i < 0 ? ~i : i], k = 0, n = a.length, p; k < n; ++k) {
        points.push(p = a[k].slice());
        absolute(p, k);
      }
      if (i < 0) reverse(points, n);
    }

    function point(p) {
      p = p.slice();
      absolute(p, 0);
      return p;
    }

    function line(arcs) {
      var points = [];
      for (var i = 0, n = arcs.length; i < n; ++i) arc(arcs[i], points);
      if (points.length < 2) points.push(points[0].slice());
      return points;
    }

    function ring(arcs) {
      var points = line(arcs);
      while (points.length < 4) points.push(points[0].slice());
      return points;
    }

    function polygon(arcs) {
      return arcs.map(ring);
    }

    function geometry(o) {
      var t = o.type;
      return t === "GeometryCollection" ? {type: t, geometries: o.geometries.map(geometry)}
          : t in geometryType ? {type: t, coordinates: geometryType[t](o)}
          : null;
    }

    var geometryType = {
      Point: function(o) { return point(o.coordinates); },
      MultiPoint: function(o) { return o.coordinates.map(point); },
      LineString: function(o) { return line(o.arcs); },
      MultiLineString: function(o) { return o.arcs.map(line); },
      Polygon: function(o) { return polygon(o.arcs); },
      MultiPolygon: function(o) { return o.arcs.map(polygon); }
    };

    return geometry(o);
  }

  function reverse(array, n) {
    var t, j = array.length, i = j - n; while (i < --j) t = array[i], array[i++] = array[j], array[j] = t;
  }

  function bisect(a, x) {
    var lo = 0, hi = a.length;
    while (lo < hi) {
      var mid = lo + hi >>> 1;
      if (a[mid] < x) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  function neighbors(objects) {
    var indexesByArc = {}, // arc index -> array of object indexes
        neighbors = objects.map(function() { return []; });

    function line(arcs, i) {
      arcs.forEach(function(a) {
        if (a < 0) a = ~a;
        var o = indexesByArc[a];
        if (o) o.push(i);
        else indexesByArc[a] = [i];
      });
    }

    function polygon(arcs, i) {
      arcs.forEach(function(arc) { line(arc, i); });
    }

    function geometry(o, i) {
      if (o.type === "GeometryCollection") o.geometries.forEach(function(o) { geometry(o, i); });
      else if (o.type in geometryType) geometryType[o.type](o.arcs, i);
    }

    var geometryType = {
      LineString: line,
      MultiLineString: polygon,
      Polygon: polygon,
      MultiPolygon: function(arcs, i) { arcs.forEach(function(arc) { polygon(arc, i); }); }
    };

    objects.forEach(geometry);

    for (var i in indexesByArc) {
      for (var indexes = indexesByArc[i], m = indexes.length, j = 0; j < m; ++j) {
        for (var k = j + 1; k < m; ++k) {
          var ij = indexes[j], ik = indexes[k], n;
          if ((n = neighbors[ij])[i = bisect(n, ik)] !== ik) n.splice(i, 0, ik);
          if ((n = neighbors[ik])[i = bisect(n, ij)] !== ij) n.splice(i, 0, ij);
        }
      }
    }

    return neighbors;
  }

  function presimplify(topology, triangleArea) {
    var absolute = transformAbsolute(topology.transform),
        relative = transformRelative(topology.transform),
        heap = minAreaHeap(),
        maxArea = 0,
        triangle;

    if (!triangleArea) triangleArea = cartesianTriangleArea;

    topology.arcs.forEach(function(arc) {
      var triangles = [];

      arc.forEach(absolute);

      for (var i = 1, n = arc.length - 1; i < n; ++i) {
        triangle = arc.slice(i - 1, i + 2);
        triangle[1][2] = triangleArea(triangle);
        triangles.push(triangle);
        heap.push(triangle);
      }

      // Always keep the arc endpoints!
      arc[0][2] = arc[n][2] = Infinity;

      for (var i = 0, n = triangles.length; i < n; ++i) {
        triangle = triangles[i];
        triangle.previous = triangles[i - 1];
        triangle.next = triangles[i + 1];
      }
    });

    while (triangle = heap.pop()) {
      var previous = triangle.previous,
          next = triangle.next;

      // If the area of the current point is less than that of the previous point
      // to be eliminated, use the latter's area instead. This ensures that the
      // current point cannot be eliminated without eliminating previously-
      // eliminated points.
      if (triangle[1][2] < maxArea) triangle[1][2] = maxArea;
      else maxArea = triangle[1][2];

      if (previous) {
        previous.next = next;
        previous[2] = triangle[2];
        update(previous);
      }

      if (next) {
        next.previous = previous;
        next[0] = triangle[0];
        update(next);
      }
    }

    topology.arcs.forEach(function(arc) {
      arc.forEach(relative);
    });

    function update(triangle) {
      heap.remove(triangle);
      triangle[1][2] = triangleArea(triangle);
      heap.push(triangle);
    }

    return topology;
  };

  function cartesianRingArea(ring) {
    var i = -1,
        n = ring.length,
        a,
        b = ring[n - 1],
        area = 0;

    while (++i < n) {
      a = b;
      b = ring[i];
      area += a[0] * b[1] - a[1] * b[0];
    }

    return area * .5;
  }

  function cartesianTriangleArea(triangle) {
    var a = triangle[0], b = triangle[1], c = triangle[2];
    return Math.abs((a[0] - c[0]) * (b[1] - a[1]) - (a[0] - b[0]) * (c[1] - a[1]));
  }

  function compareArea(a, b) {
    return a[1][2] - b[1][2];
  }

  function minAreaHeap() {
    var heap = {},
        array = [],
        size = 0;

    heap.push = function(object) {
      up(array[object._ = size] = object, size++);
      return size;
    };

    heap.pop = function() {
      if (size <= 0) return;
      var removed = array[0], object;
      if (--size > 0) object = array[size], down(array[object._ = 0] = object, 0);
      return removed;
    };

    heap.remove = function(removed) {
      var i = removed._, object;
      if (array[i] !== removed) return; // invalid request
      if (i !== --size) object = array[size], (compareArea(object, removed) < 0 ? up : down)(array[object._ = i] = object, i);
      return i;
    };

    function up(object, i) {
      while (i > 0) {
        var j = ((i + 1) >> 1) - 1,
            parent = array[j];
        if (compareArea(object, parent) >= 0) break;
        array[parent._ = i] = parent;
        array[object._ = i = j] = object;
      }
    }

    function down(object, i) {
      while (true) {
        var r = (i + 1) << 1,
            l = r - 1,
            j = i,
            child = array[j];
        if (l < size && compareArea(array[l], child) < 0) child = array[j = l];
        if (r < size && compareArea(array[r], child) < 0) child = array[j = r];
        if (j === i) break;
        array[child._ = i] = child;
        array[object._ = i = j] = object;
      }
    }

    return heap;
  }

  function transformAbsolute(transform) {
    if (!transform) return noop;
    var x0,
        y0,
        kx = transform.scale[0],
        ky = transform.scale[1],
        dx = transform.translate[0],
        dy = transform.translate[1];
    return function(point, i) {
      if (!i) x0 = y0 = 0;
      point[0] = (x0 += point[0]) * kx + dx;
      point[1] = (y0 += point[1]) * ky + dy;
    };
  }

  function transformRelative(transform) {
    if (!transform) return noop;
    var x0,
        y0,
        kx = transform.scale[0],
        ky = transform.scale[1],
        dx = transform.translate[0],
        dy = transform.translate[1];
    return function(point, i) {
      if (!i) x0 = y0 = 0;
      var x1 = (point[0] - dx) / kx | 0,
          y1 = (point[1] - dy) / ky | 0;
      point[0] = x1 - x0;
      point[1] = y1 - y0;
      x0 = x1;
      y0 = y1;
    };
  }

  function noop() {}

  if (typeof define === "function" && define.amd) define(topojson);
  else if (typeof module === "object" && module.exports) module.exports = topojson;
  else this.topojson = topojson;
}();
!function(){function t(n,t){function r(t){var r,e=n.arcs[0>t?~t:t],o=e[0];return n.transform?(r=[0,0],e.forEach(function(n){r[0]+=n[0],r[1]+=n[1]})):r=e[e.length-1],0>t?[r,o]:[o,r]}function e(n,t){for(var r in n){var e=n[r];delete t[e.start],delete e.start,delete e.end,e.forEach(function(n){o[0>n?~n:n]=1}),f.push(e)}}var o={},i={},u={},f=[],c=-1;return t.forEach(function(r,e){var o,i=n.arcs[0>r?~r:r];i.length<3&&!i[1][0]&&!i[1][1]&&(o=t[++c],t[c]=r,t[e]=o)}),t.forEach(function(n){var t,e,o=r(n),f=o[0],c=o[1];if(t=u[f])if(delete u[t.end],t.push(n),t.end=c,e=i[c]){delete i[e.start];var a=e===t?t:t.concat(e);i[a.start=t.start]=u[a.end=e.end]=a}else i[t.start]=u[t.end]=t;else if(t=i[c])if(delete i[t.start],t.unshift(n),t.start=f,e=u[f]){delete u[e.end];var s=e===t?t:e.concat(t);i[s.start=e.start]=u[s.end=t.end]=s}else i[t.start]=u[t.end]=t;else t=[n],i[t.start=f]=u[t.end=c]=t}),e(u,i),e(i,u),t.forEach(function(n){o[0>n?~n:n]||f.push([n])}),f}function r(n,r,e){function o(n){var t=0>n?~n:n;(s[t]||(s[t]=[])).push({i:n,g:a})}function i(n){n.forEach(o)}function u(n){n.forEach(i)}function f(n){"GeometryCollection"===n.type?n.geometries.forEach(f):n.type in l&&(a=n,l[n.type](n.arcs))}var c=[];if(arguments.length>1){var a,s=[],l={LineString:i,MultiLineString:u,Polygon:u,MultiPolygon:function(n){n.forEach(u)}};f(r),s.forEach(arguments.length<3?function(n){c.push(n[0].i)}:function(n){e(n[0].g,n[n.length-1].g)&&c.push(n[0].i)})}else for(var h=0,p=n.arcs.length;p>h;++h)c.push(h);return{type:"MultiLineString",arcs:t(n,c)}}function e(r,e){function o(n){n.forEach(function(t){t.forEach(function(t){(f[t=0>t?~t:t]||(f[t]=[])).push(n)})}),c.push(n)}function i(n){return l(u(r,{type:"Polygon",arcs:[n]}).coordinates[0])>0}var f={},c=[],a=[];return e.forEach(function(n){"Polygon"===n.type?o(n.arcs):"MultiPolygon"===n.type&&n.arcs.forEach(o)}),c.forEach(function(n){if(!n._){var t=[],r=[n];for(n._=1,a.push(t);n=r.pop();)t.push(n),n.forEach(function(n){n.forEach(function(n){f[0>n?~n:n].forEach(function(n){n._||(n._=1,r.push(n))})})})}}),c.forEach(function(n){delete n._}),{type:"MultiPolygon",arcs:a.map(function(e){var o=[];if(e.forEach(function(n){n.forEach(function(n){n.forEach(function(n){f[0>n?~n:n].length<2&&o.push(n)})})}),o=t(r,o),(n=o.length)>1)for(var u,c=i(e[0][0]),a=0;n>a;++a)if(c===i(o[a])){u=o[0],o[0]=o[a],o[a]=u;break}return o})}}function o(n,t){return"GeometryCollection"===t.type?{type:"FeatureCollection",features:t.geometries.map(function(t){return i(n,t)})}:i(n,t)}function i(n,t){var r={type:"Feature",id:t.id,properties:t.properties||{},geometry:u(n,t)};return null==t.id&&delete r.id,r}function u(n,t){function r(n,t){t.length&&t.pop();for(var r,e=s[0>n?~n:n],o=0,i=e.length;i>o;++o)t.push(r=e[o].slice()),a(r,o);0>n&&f(t,i)}function e(n){return n=n.slice(),a(n,0),n}function o(n){for(var t=[],e=0,o=n.length;o>e;++e)r(n[e],t);return t.length<2&&t.push(t[0].slice()),t}function i(n){for(var t=o(n);t.length<4;)t.push(t[0].slice());return t}function u(n){return n.map(i)}function c(n){var t=n.type;return"GeometryCollection"===t?{type:t,geometries:n.geometries.map(c)}:t in l?{type:t,coordinates:l[t](n)}:null}var a=g(n.transform),s=n.arcs,l={Point:function(n){return e(n.coordinates)},MultiPoint:function(n){return n.coordinates.map(e)},LineString:function(n){return o(n.arcs)},MultiLineString:function(n){return n.arcs.map(o)},Polygon:function(n){return u(n.arcs)},MultiPolygon:function(n){return n.arcs.map(u)}};return c(t)}function f(n,t){for(var r,e=n.length,o=e-t;o<--e;)r=n[o],n[o++]=n[e],n[e]=r}function c(n,t){for(var r=0,e=n.length;e>r;){var o=r+e>>>1;n[o]<t?r=o+1:e=o}return r}function a(n){function t(n,t){n.forEach(function(n){0>n&&(n=~n);var r=o[n];r?r.push(t):o[n]=[t]})}function r(n,r){n.forEach(function(n){t(n,r)})}function e(n,t){"GeometryCollection"===n.type?n.geometries.forEach(function(n){e(n,t)}):n.type in u&&u[n.type](n.arcs,t)}var o={},i=n.map(function(){return[]}),u={LineString:t,MultiLineString:r,Polygon:r,MultiPolygon:function(n,t){n.forEach(function(n){r(n,t)})}};n.forEach(e);for(var f in o)for(var a=o[f],s=a.length,l=0;s>l;++l)for(var h=l+1;s>h;++h){var p,v=a[l],g=a[h];(p=i[v])[f=c(p,g)]!==g&&p.splice(f,0,g),(p=i[g])[f=c(p,v)]!==v&&p.splice(f,0,v)}return i}function s(n,t){function r(n){u.remove(n),n[1][2]=t(n),u.push(n)}var e,o=g(n.transform),i=m(n.transform),u=v(),f=0;for(t||(t=h),n.arcs.forEach(function(n){var r=[];n.forEach(o);for(var i=1,f=n.length-1;f>i;++i)e=n.slice(i-1,i+2),e[1][2]=t(e),r.push(e),u.push(e);n[0][2]=n[f][2]=1/0;for(var i=0,f=r.length;f>i;++i)e=r[i],e.previous=r[i-1],e.next=r[i+1]});e=u.pop();){var c=e.previous,a=e.next;e[1][2]<f?e[1][2]=f:f=e[1][2],c&&(c.next=a,c[2]=e[2],r(c)),a&&(a.previous=c,a[0]=e[0],r(a))}return n.arcs.forEach(function(n){n.forEach(i)}),n}function l(n){for(var t,r=-1,e=n.length,o=n[e-1],i=0;++r<e;)t=o,o=n[r],i+=t[0]*o[1]-t[1]*o[0];return.5*i}function h(n){var t=n[0],r=n[1],e=n[2];return Math.abs((t[0]-e[0])*(r[1]-t[1])-(t[0]-r[0])*(e[1]-t[1]))}function p(n,t){return n[1][2]-t[1][2]}function v(){function n(n,t){for(;t>0;){var r=(t+1>>1)-1,o=e[r];if(p(n,o)>=0)break;e[o._=t]=o,e[n._=t=r]=n}}function t(n,t){for(;;){var r=t+1<<1,i=r-1,u=t,f=e[u];if(o>i&&p(e[i],f)<0&&(f=e[u=i]),o>r&&p(e[r],f)<0&&(f=e[u=r]),u===t)break;e[f._=t]=f,e[n._=t=u]=n}}var r={},e=[],o=0;return r.push=function(t){return n(e[t._=o]=t,o++),o},r.pop=function(){if(!(0>=o)){var n,r=e[0];return--o>0&&(n=e[o],t(e[n._=0]=n,0)),r}},r.remove=function(r){var i,u=r._;if(e[u]===r)return u!==--o&&(i=e[o],(p(i,r)<0?n:t)(e[i._=u]=i,u)),u},r}function g(n){if(!n)return y;var t,r,e=n.scale[0],o=n.scale[1],i=n.translate[0],u=n.translate[1];return function(n,f){f||(t=r=0),n[0]=(t+=n[0])*e+i,n[1]=(r+=n[1])*o+u}}function m(n){if(!n)return y;var t,r,e=n.scale[0],o=n.scale[1],i=n.translate[0],u=n.translate[1];return function(n,f){f||(t=r=0);var c=0|(n[0]-i)/e,a=0|(n[1]-u)/o;n[0]=c-t,n[1]=a-r,t=c,r=a}}function y(){}var d={version:"1.6.14",mesh:function(n){return u(n,r.apply(this,arguments))},meshArcs:r,merge:function(n){return u(n,e.apply(this,arguments))},mergeArcs:e,feature:o,neighbors:a,presimplify:s};"function"==typeof define&&define.amd?define(d):"object"==typeof module&&module.exports?module.exports=d:this.topojson=d}();