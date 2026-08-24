/* 手机端图片保存优化：点击下载直接唤起系统保存/分享，不再跳浏览器新页面 */
(function () {
  if (!/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) return;

  function toast(msg) {
    var el = document.createElement("div");
    el.textContent = msg;
    el.style.cssText = "position:fixed;left:50%;bottom:90px;transform:translateX(-50%);" +
      "background:rgba(20,20,30,.92);color:#fff;padding:10px 18px;border-radius:10px;" +
      "font-size:14px;z-index:999999;max-width:80%;text-align:center;pointer-events:none;";
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2400);
  }

  function imageIdFromHref(href) {
    var m = String(href || "").match(/\/api\/images\/([^?&]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }

  function nameFromHref(href) {
    var m = String(href || "").match(/[?&]name=([^&]+)/);
    return m ? decodeURIComponent(m[1]) : "图片";
  }

  function imgUrl(id) {
    return "/api/images/" + encodeURIComponent(id) + "?deviceId=" + encodeURIComponent(localStorage.getItem("wos_device_id") || "");
  }

  function showPreview(url, name) {
    var mask = document.createElement("div");
    mask.style.cssText = "position:fixed;inset:0;background:rgba(10,10,16,.94);z-index:999999;" +
      "display:flex;flex-direction:column;align-items:center;justify-content:center;";
    var img = document.createElement("img");
    img.src = url;
    img.alt = name;
    img.style.cssText = "max-width:92%;max-height:68%;border-radius:10px;box-shadow:0 6px 30px rgba(0,0,0,.6);";
    var tip = document.createElement("div");
    tip.style.cssText = "color:#e8e8f0;margin-top:20px;font-size:15px;text-align:center;line-height:1.9;";
    tip.innerHTML = "长按图片 → <b>存储图像 / 保存图片</b><br>即可保存到手机相册";
    var btn = document.createElement("button");
    btn.textContent = "关 闭";
    btn.style.cssText = "margin-top:18px;padding:10px 30px;border:none;border-radius:22px;" +
      "background:linear-gradient(135deg,#4f7cff,#7b5cff);color:#fff;font-size:15px;";
    btn.addEventListener("click", function () { mask.remove(); });
    mask.appendChild(img);
    mask.appendChild(tip);
    mask.appendChild(btn);
    mask.addEventListener("click", function (e) { if (e.target === mask) mask.remove(); });
    document.body.appendChild(mask);
  }

  function tryShare(url, name) {
    fetch(url)
      .then(function (r) { if (!r.ok) throw new Error(r.status); return r.blob(); })
      .then(function (blob) {
        var ext = blob.type === "image/png" ? "png" : blob.type === "image/gif" ? "gif" : "jpg";
        var file = new File([blob], name + "." + ext, { type: blob.type });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          navigator.share({ files: [file], title: name })
            .then(function () { toast("已分享/保存"); })
            .catch(function (err) {
              if (err && err.name === "AbortError") return;
              showPreview(url, name);
            });
        } else {
          showPreview(url, name);
        }
      })
      .catch(function () { showPreview(url, name); });
  }

  document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest('[data-act="dl"]') : null;
    if (!a) return;
    var id = imageIdFromHref(a.getAttribute("href"));
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    tryShare(imgUrl(id), nameFromHref(a.getAttribute("href")) || "图片");
  });
})();
