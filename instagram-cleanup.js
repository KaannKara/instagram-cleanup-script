/****************************************************
 * Instagram "Beni Takip Edenler" + 
 * "Ben de Takip Ediyor muyum?" Bilgisi
 *
 * Yeni Özellikler:
 *   1) "Takip Etmediklerimi Toplu Seç" tüm sayfalardaki 
 *      (iFollowThisUser = false) kullanıcıları seçer 
 *      (sadece ilk sayfadakileri değil).
 *   2) "Seçilenleri Çıkar" işlemi sonrası çıkarılan 
 *      kullanıcıların kartları kırmızıya boyanır ve 
 *      checkbox'ları devre dışı kalır (disabled).
 *
 * Kullanım:
 *   1) Instagram'da oturum açıkken tarayıcı konsoluna
 *      bu kodu tek parça yapıştırın ve ENTER'a basın.
 *   2) Açılan pencerenin "Kaç kişi çekilsin?" kısmına 
 *      (örneğin 200) girip "Run" butonuna tıklayın.
 *   3) Kod, önce "followers" (beni takip edenler) 
 *      limit kadar, sonra "following" (benim takip 
 *      ettiklerim) limit kadar çekip birleştirir.
 *   4) "Takip Etmediklerimi Toplu Seç" butonuna basınca,
 *      tüm sayfalardaki, "Takip etmiyorum" durumundaki 
 *      kullanıcılar checkbox olarak seçilir.
 *   5) "Seçilenleri Çıkar" ile remove_follower işlemi 
 *      yapılır. Başarıyla çıkarılan kullanıcılar 
 *      ekranda kırmızı arka planla belirir ve checkbox 
 *      disabled olur.
 *
 * Uyarı:
 *   - Bu tür otomasyonlar Instagram'ın kullanım 
 *     koşullarını ihlâl edebilir, hesabınız 
 *     kısıtlanabilir veya kapatılabilir.
 *   - Tüm risk ve sorumluluk size aittir.
 *   - Instagram sık sık query_hash vb. değerlerini 
 *     değiştirebilmektedir.
 ****************************************************/

// ============ AYARLAR ============
const PAGE_SIZE = 20;                 // Sayfa başına gösterilecek kullanıcı sayısı
const TIME_BETWEEN_REMOVALS = 4000;   // Her remove_follower arası bekleme (ms)
const TIME_AFTER_FIVE_REMOVALS = 300000; // 5 işlemde bir uzun bekleme (5 dk)

// ============ Global Durum Değişkenleri ============
let fetchLimit = 0;            // Arayüzden girilecek sayı (örn. 200)
let followersData = [];        // Beni takip edenler
let followingData = [];        // Benim takip ettiklerim
let extendedFollowers = [];    // Tüm follower'lar + "iFollowThisUser" bilgisi
let currentPageIndex = 0;      // Aktif sayfa indeks
let selectedIds = new Set();   // Seçilmiş user.id'ler
let isScanning = false;        // Veri çekme işlemi devam ediyor mu?
let isRemoving = false;        // remove_follower işlemi sürüyor mu?

/* ========================================================
   1) YARDIMCI FONKSİYONLAR: ds_user_id, csrftoken, vb.
======================================================== */
function getLoggedInUserId() {
  const match = document.cookie.match(/ds_user_id=([^;]+)/);
  return match ? match[1] : null;
}

function getCsrfToken() {
  const match = document.cookie.match(/csrftoken=([^;]+)/);
  return match ? match[1] : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * "Beni takip edenler" GraphQL URL
 */
function generateFollowersUrl(cursor) {
  const userId = getLoggedInUserId();
  if (!userId) throw new Error("Kullanıcı ID (ds_user_id) bulunamadı!");
  const queryHash = "c76146de99bb02f6415203be841dd25a"; // followers
  const variables = {
    id: userId,
    include_reel: true,
    fetch_mutual: false,
    first: 24
  };
  if (cursor) variables.after = cursor;
  return `https://www.instagram.com/graphql/query/?query_hash=${queryHash}&variables=` + 
    encodeURIComponent(JSON.stringify(variables));
}

/**
 * "Benim takip ettiklerim" (following) GraphQL URL
 */
function generateFollowingUrl(cursor) {
  const userId = getLoggedInUserId();
  if (!userId) throw new Error("Kullanıcı ID (ds_user_id) bulunamadı!");
  const queryHash = "d04b0a864b4b54837c0d870b0e77e076"; // following
  const variables = {
    id: userId,
    include_reel: true,
    fetch_mutual: false,
    first: 24
  };
  if (cursor) variables.after = cursor;
  return `https://www.instagram.com/graphql/query/?query_hash=${queryHash}&variables=` + 
    encodeURIComponent(JSON.stringify(variables));
}

/**
 * remove_follower URL -> "beni takip edenlerden çıkarma"
 */
function generateRemoveFollowerUrl(userId) {
  return `https://www.instagram.com/web/friendships/${userId}/remove_follower/`;
}

/**
 * Belirtilen URL fonksiyonuyla (followers/following) sayfaları 
 * tek tek çekerek birleştirir. "limit" kadar veriye ulaştığında durur.
 */
async function fetchGraphQLUsers(fetchUrlFn, limit) {
  let results = [];
  let cursor = null;

  while (true) {
    const url = fetchUrlFn(cursor);
    const resp = await fetch(url, {
      method: "GET",
      credentials: "include"
    });
    if (!resp.ok) {
      console.error("Veri çekilirken hata:", resp.status);
      break;
    }

    const data = await resp.json();
    const edges =
      data?.data?.user?.edge_followed_by?.edges ||
      data?.data?.user?.edge_follow?.edges ||
      [];
    const pageInfo =
      data?.data?.user?.edge_followed_by?.page_info ||
      data?.data?.user?.edge_follow?.page_info;

    for (const edge of edges) {
      results.push({
        username: edge.node.username,
        full_name: edge.node.full_name,
        id: edge.node.id,
        profile_pic_url: edge.node.profile_pic_url,
      });
      if (results.length >= limit) break;
    }

    if (results.length >= limit) break;
    if (!pageInfo?.has_next_page) break;

    cursor = pageInfo.end_cursor;
    // sayfalar arası mini bekleme
    await sleep(500);
  }

  return results;
}

/* ========================================================
   2) ANA İŞLEMLER: Veri Çekme, Birleştirme, iFollowThisUser
======================================================== */
async function handleFetchData() {
  // Kullanıcıdan limit değerini al
  const limitInput = document.getElementById("fetch-limit-input");
  fetchLimit = parseInt(limitInput.value || "0", 10);
  if (isNaN(fetchLimit) || fetchLimit <= 0) {
    alert("Lütfen geçerli bir sayı girin!");
    return;
  }

  if (isScanning) {
    alert("Zaten veri çekiliyor. Lütfen bekleyin...");
    return;
  }
  isScanning = true;
  currentPageIndex = 0;
  selectedIds.clear();

  // Temizle
  followersData = [];
  followingData = [];
  extendedFollowers = [];
  renderPage(); // Ekranı sıfırla

  try {
    console.log("Followers verileri çekiliyor...");
    followersData = await fetchGraphQLUsers(generateFollowersUrl, fetchLimit);
    console.log(`Followers çekildi: ${followersData.length} adet`);

    console.log("Following verileri çekiliyor...");
    followingData = await fetchGraphQLUsers(generateFollowingUrl, fetchLimit);
    console.log(`Following çekildi: ${followingData.length} adet`);

    // Following'i ID map haline getirelim
    const followingSet = new Set(followingData.map(u => u.id));

    // extendedFollowers = followers + "iFollowThisUser" bilgisi
    extendedFollowers = followersData.map(fw => ({
      ...fw,
      iFollowThisUser: followingSet.has(fw.id),
      removed: false  // yeni ekledik => çıkarılanlara işaret
    }));

    console.log("Liste birleştirme tamam.");
  } catch (err) {
    console.error("Veri çekmede hata:", err);
  }

  isScanning = false;
  renderPage();
  console.log("Veri çekme işlemi tamamlandı.");
}

/* ========================================================
   3) REMOVE FOLLOWER (Seçilenleri Çıkar)
======================================================== */
async function bulkRemoveFollower() {
  if (isRemoving) {
    alert("Zaten kaldırma işlemi devam ediyor!");
    return;
  }
  if (!selectedIds.size) {
    alert("Hiç kullanıcı seçilmedi!");
    return;
  }

  const confirmMsg = 
    `Seçilen ${selectedIds.size} kişiyi takipçinizden çıkarmak istediğinize emin misiniz?`;
  if (!confirm(confirmMsg)) {
    return;
  }

  isRemoving = true;
  renderPage(); // Checkbox'ları devre dışı bırak

  let removalCount = 0;
  const csrfToken = getCsrfToken();

  for (const userId of selectedIds) {
    // "extendedFollowers" içinden user objesini bul (arka planı kırmızı yapacağız)
    const user = extendedFollowers.find(u => u.id === userId);
    if (!user || user.removed) {
      continue; // zaten kaldırılmış
    }

    try {
      const removeUrl = generateRemoveFollowerUrl(userId);
      const resp = await fetch(removeUrl, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-CSRFToken": csrfToken
        },
        body: ""
      });

      if (resp.ok) {
        console.log(`${user.username} çıkarıldı.`);
        user.removed = true;        // Kartı kırmızı yapacağımız işaret
      } else {
        console.warn(`Çıkarma isteği başarısız: ${user.username}, status = ${resp.status}`);
      }
    } catch (err) {
      console.error(`Hata: ${user.username} -`, err);
    }

    removalCount++;
    // Seçimden çıkaralım ki tekrar işlenmesin
    // (Bir sonraki tur re-render için)
    selectedIds.delete(userId);

    // Her işlem sonrası re-render ederek anlık kırmızı efekt göstermek isterseniz:
    renderPage();

    // Bekleme
    await sleep(TIME_BETWEEN_REMOVALS);

    // Her 5 kişide bir uzun bekleme
    if (removalCount % 5 === 0) {
      console.log(`5 kullanıcı çıkarıldı, ${TIME_AFTER_FIVE_REMOVALS / 1000}s bekleniyor...`);
      await sleep(TIME_AFTER_FIVE_REMOVALS);
    }
  }

  isRemoving = false;
  alert("Seçilenleri çıkarma işlemi tamamlandı!");
  renderPage();
}

/* ========================================================
   4) "Takip Etmediklerimi Toplu Seç"
   - Tüm extendedFollowers'ta iFollowThisUser=false olanları işaretle
======================================================== */
function selectNotFollowed() {
  extendedFollowers.forEach((user) => {
    // Takip etmiyorsak & henüz kaldırılmamışsa
    if (!user.iFollowThisUser && !user.removed) {
      selectedIds.add(user.id);
    }
  });
  renderPage();
}

/* ========================================================
   5) SAYFALAMA
======================================================== */
function getPageData(pageIndex) {
  const start = pageIndex * PAGE_SIZE;
  const end = start + PAGE_SIZE;
  // Kaldırılmış (removed) kullanıcılar da listede duruyor
  // ama yine de kartı kırmızıya boyayacağız.
  return extendedFollowers.slice(start, end);
}

function getTotalPages() {
  return Math.ceil(extendedFollowers.length / PAGE_SIZE) || 1;
}

function setPageIndex(newIndex) {
  const maxPage = getTotalPages() - 1;
  if (newIndex < 0) newIndex = 0;
  if (newIndex > maxPage) newIndex = maxPage;
  currentPageIndex = newIndex;
  renderPage();
}

function renderPagination() {
  const pagDiv = document.getElementById("custom-pagination");
  if (!pagDiv) return;
  pagDiv.innerHTML = "";

  const totalPages = getTotalPages();
  
  // Geri butonu
  const prevBtn = document.createElement("button");
  prevBtn.textContent = "← Geri";
  prevBtn.style.cssText = `
    margin-right:1rem; cursor:pointer; 
    background:#444; color:#fff; border:1px solid #666; 
    padding:0.5rem 1rem; border-radius:4px;
  `;
  prevBtn.onclick = () => setPageIndex(currentPageIndex - 1);
  pagDiv.appendChild(prevBtn);

  // Sayfa metni
  const pageSpan = document.createElement("span");
  pageSpan.textContent = `Sayfa ${currentPageIndex + 1} / ${totalPages}`;
  pageSpan.style.marginRight = "1rem";
  pagDiv.appendChild(pageSpan);

  // İleri butonu
  const nextBtn = document.createElement("button");
  nextBtn.textContent = "İleri →";
  nextBtn.style.cssText = `
    margin-right:1rem; cursor:pointer; 
    background:#444; color:#fff; border:1px solid #666; 
    padding:0.5rem 1rem; border-radius:4px;
  `;
  nextBtn.onclick = () => setPageIndex(currentPageIndex + 1);
  pagDiv.appendChild(nextBtn);
}

/* ========================================================
   6) SAYFAYI RENDER ET
   - Kart oluşturma: Arka planı removed = true ise kırmızı
   - Checkbox disable, eğer isRemoving = true (genel) veya user.removed = true (özel)
======================================================== */
function renderPage() {
  renderPagination();

  const listDiv = document.getElementById("custom-list-div");
  if (!listDiv) return;
  listDiv.innerHTML = "";

  const data = getPageData(currentPageIndex);
  if (!data.length) {
    listDiv.textContent = "Gösterilecek kullanıcı yok.";
    return;
  }

  const container = document.createElement("div");
  container.style.cssText = "display:flex; flex-wrap:wrap; gap:1rem;";

  data.forEach((user) => {
    // Kart
    const card = document.createElement("div");
    // Eğer user.removed true ise kırmızı arka plan yap
    card.style.cssText = `
      width:180px; border:1px solid #444; border-radius:6px; 
      padding:0.5rem; background:${user.removed ? "#a00" : "#222"};
      display:flex; flex-direction:column; align-items:center;
    `;

    // Profil fotoğrafı
    const img = document.createElement("img");
    img.src = user.profile_pic_url || "";
    img.alt = user.username;
    img.style.cssText = `
      width:80px; height:80px; 
      border-radius:50%; object-fit:cover;
      margin-bottom:0.5rem;
      border:2px solid #333;
    `;
    card.appendChild(img);

    // Kullanıcı adı (link)
    const link = document.createElement("a");
    link.href = `https://www.instagram.com/${user.username}/`;
    link.target = "_blank";
    link.textContent = `@${user.username}`;
    link.style.cssText = `
      color:#46cdfb; text-decoration:none; font-weight:bold;
      margin-bottom:0.25rem;
    `;
    card.appendChild(link);

    // Ad-soyad
    if (user.full_name) {
      const nameDiv = document.createElement("div");
      nameDiv.textContent = user.full_name;
      nameDiv.style.cssText = `
        color:#ccc; font-size:0.9rem; margin-bottom:0.25rem;
      `;
      card.appendChild(nameDiv);
    }

    // "Ben de takip ediyorum" bilgisi
    const weFollowLabel = document.createElement("div");
    weFollowLabel.textContent = user.iFollowThisUser
      ? "Ben de takip ediyorum"
      : "Takip etmiyorum";
    weFollowLabel.style.cssText = `
      margin-bottom:0.25rem; color:${user.iFollowThisUser ? "#5f5" : "#faa"};
    `;
    card.appendChild(weFollowLabel);

    // Checkbox
    const label = document.createElement("label");
    label.style.cssText = "display:flex; align-items:center; cursor:pointer;";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.style.marginRight = "0.5rem";

    // Eğer bu user seçiliyse
    cb.checked = selectedIds.has(user.id);

    // Eğer işlem sürüyor veya user zaten çıkarılmışsa disable
    cb.disabled = isRemoving || user.removed;

    cb.addEventListener("change", () => {
      if (cb.checked) {
        selectedIds.add(user.id);
      } else {
        selectedIds.delete(user.id);
      }
    });
    label.appendChild(cb);
    label.appendChild(document.createTextNode("Seç"));
    card.appendChild(label);

    container.appendChild(card);
  });

  listDiv.appendChild(container);
}

/* ========================================================
   7) "Takip Etmediklerimi Toplu Seç" - Tüm veride işlem
======================================================== */
function selectNotFollowed() {
  // Tüm extendedFollowers içerisinde iFollowThisUser = false olanları ekle
  extendedFollowers.forEach((user) => {
    if (!user.iFollowThisUser && !user.removed) {
      selectedIds.add(user.id);
    }
  });
  renderPage();
}

/* ========================================================
   8) TAM EKRAN UI OLUŞTUR
======================================================== */
function createFullScreenUI() {
  if (document.getElementById("custom-fullscreen-ui")) {
    console.warn("UI zaten eklenmiş!");
    return;
  }

  // Arka plan overlay
  const overlay = document.createElement("div");
  overlay.id = "custom-fullscreen-ui";
  overlay.style.cssText = `
    position:fixed; top:0; left:0; right:0; bottom:0;
    background:#111; color:#fff; z-index:999999;
    display:flex; flex-direction:column; font-family:sans-serif;
  `;

  // Üst toolbar
  const toolbar = document.createElement("div");
  toolbar.style.cssText = `
    display:flex; align-items:center; padding:1rem;
    background:#222; border-bottom:2px solid #444;
  `;

  const title = document.createElement("h2");
  title.textContent = "Takipçi Yönetimi (Beni Takip Edenler)";
  title.style.cssText = "flex:1; margin:0; font-size:1.2rem;";
  toolbar.appendChild(title);

  // Kaç kişi çekilsin?
  const limitLabel = document.createElement("label");
  limitLabel.textContent = "Kaç kişi çekilsin? ";
  limitLabel.style.cssText = "margin-right:0.5rem;";
  toolbar.appendChild(limitLabel);

  const limitInput = document.createElement("input");
  limitInput.id = "fetch-limit-input";
  limitInput.type = "number";
  limitInput.value = "200";
  limitInput.style.cssText = `
    width:80px; margin-right:1rem; padding:0.25rem;
    background:#333; color:#fff; border:1px solid #666; 
    border-radius:4px;
  `;
  toolbar.appendChild(limitInput);

  // Run butonu
  const runBtn = document.createElement("button");
  runBtn.textContent = "Run";
  runBtn.style.cssText = `
    margin-right:1rem; cursor:pointer; background:#00b894; 
    color:#fff; border:none; padding:0.5rem 1rem; 
    border-radius:4px;
  `;
  runBtn.onclick = handleFetchData;
  toolbar.appendChild(runBtn);

  // "Takip Etmediklerimi Toplu Seç"
  const selectNotFollowBtn = document.createElement("button");
  selectNotFollowBtn.textContent = "Takip Etmediklerimi Toplu Seç";
  selectNotFollowBtn.style.cssText = `
    margin-right:1rem; cursor:pointer; background:#0984e3; 
    color:#fff; border:none; padding:0.5rem 1rem; 
    border-radius:4px;
  `;
  selectNotFollowBtn.onclick = selectNotFollowed;
  toolbar.appendChild(selectNotFollowBtn);

  // Seçilenleri Çıkar
  const removeBtn = document.createElement("button");
  removeBtn.textContent = "Seçilenleri Çıkar";
  removeBtn.style.cssText = `
    margin-right:1rem; cursor:pointer; background:#d63031; 
    color:#fff; border:none; padding:0.5rem 1rem; 
    border-radius:4px;
  `;
  removeBtn.onclick = bulkRemoveFollower;
  toolbar.appendChild(removeBtn);

  // Kapat butonu
  const closeBtn = document.createElement("button");
  closeBtn.textContent = "Kapat";
  closeBtn.style.cssText = `
    cursor:pointer; background:#636e72; color:#fff; border:none; 
    padding:0.5rem 1rem; border-radius:4px;
  `;
  closeBtn.onclick = () => document.body.removeChild(overlay);
  toolbar.appendChild(closeBtn);

  overlay.appendChild(toolbar);

  // İçerik alanı
  const content = document.createElement("div");
  content.style.cssText = "flex:1; overflow:auto; padding:1rem;";
  
  // Liste div
  const listDiv = document.createElement("div");
  listDiv.id = "custom-list-div";
  content.appendChild(listDiv);

  // Pagination div
  const paginationDiv = document.createElement("div");
  paginationDiv.id = "custom-pagination";
  paginationDiv.style.cssText = `
    margin-top:1rem; display:flex; align-items:center;
  `;
  content.appendChild(paginationDiv);

  overlay.appendChild(content);

  document.body.appendChild(overlay);
}

/* ========================================================
   9) Kodun Yüklenmesiyle Başlat
======================================================== */
createFullScreenUI();
console.log(
  "Kod yüklendi. 'Kaç kişi çekilsin?' alanına sayı girip 'Run' butonuna basın. " +
  "Sonra 'Takip Etmediklerimi Toplu Seç' -> 'Seçilenleri Çıkar' diyebilirsiniz."
);