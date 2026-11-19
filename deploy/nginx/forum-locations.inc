location = / {
    include /etc/nginx/snippets/distant-refuge-proxy.inc;
}
location = /new {
    include /etc/nginx/snippets/distant-refuge-proxy.inc;
}
location = /topics {
    include /etc/nginx/snippets/distant-refuge-proxy.inc;
}
location ^~ /topics/ {
    include /etc/nginx/snippets/distant-refuge-proxy.inc;
}
location = /report {
    include /etc/nginx/snippets/distant-refuge-proxy.inc;
}
location = /archive {
    include /etc/nginx/snippets/distant-refuge-proxy.inc;
}
location = /robots.txt {
    include /etc/nginx/snippets/distant-refuge-proxy.inc;
}
location = /sitemap.xml {
    include /etc/nginx/snippets/distant-refuge-proxy.inc;
}
location = /assets/forum.css {
    include /etc/nginx/snippets/distant-refuge-proxy.inc;
}
location = /assets/favicon.svg {
    include /etc/nginx/snippets/distant-refuge-proxy.inc;
}
